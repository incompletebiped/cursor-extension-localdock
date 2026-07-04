import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SshClient } from '../api/SshClient';
import { SftpClient } from '../api/SftpClient';
import { WordPressSite } from '../models/Site';
import { COMPANION_PLUGIN_FILES } from './companionPluginFiles.generated';
import { isValidDbIdentifier, isValidDbHost } from '../utils/pathUtils';
import { LocalDockError, LocalDockErrorCode } from '../utils/errors';
import { logger } from '../utils/logger';

const PLUGIN_REMOTE_DIR = 'wp-content/plugins/localdock-companion';

export interface ProvisionResult {
  activated: boolean;
  apiKey?: string;
  message: string;
}

/**
 * Uploads the bundled LocalDock Companion plugin to the site, tries to activate
 * it via wp-cli (falling back to a direct PHP CLI activation if wp-cli isn't
 * usable), then reads back its generated API key with a read-only SQL
 * SELECT — which works regardless of which activation path succeeded, since
 * it's the same mechanism `checkRemoteDiff`/`pullDatabase` already use to
 * reach the site's database over SSH.
 */
export async function provisionCompanionPlugin(
  site: WordPressSite,
  dbPass: string,
  ssh: SshClient,
  sftp: SftpClient
): Promise<ProvisionResult> {
  await uploadPluginFiles(site.docroot, sftp);
  logger.info(`[CompanionProvisioner] Uploaded plugin files to ${site.domain}`);

  // wp-cli activation only works when the `wp` binary is on the SSH session's
  // PATH — many cPanel hosts don't put it there for non-interactive sessions
  // even when it's installed. Fall back to driving WordPress's own
  // activate_plugin() directly via the PHP CLI, which is present on
  // essentially any host that can run WordPress at all.
  let activated = await tryActivateViaWpCli(site.docroot, ssh);
  if (!activated) {
    activated = await tryActivateViaPhpCli(site.docroot, ssh, sftp);
  }

  const apiKey = await fetchApiKeyFromDb(site, dbPass, ssh, sftp);

  if (apiKey) {
    return {
      activated: true,
      apiKey,
      message: `LocalDock Companion is active on ${site.domain}.`,
    };
  }

  if (activated) {
    return {
      activated: true,
      message: `Plugin activated on ${site.domain}, but its API key could not be read back. Check Settings > LocalDock Companion on the site.`,
    };
  }

  return {
    activated: false,
    message: `Plugin uploaded to ${site.domain}, but it could not be activated automatically (wp-cli and PHP CLI activation both failed). Activate "LocalDock Companion" under Plugins in wp-admin, then run "Provision Companion Plugin" here again to pick up its API key.`,
  };
}

async function uploadPluginFiles(docroot: string, sftp: SftpClient): Promise<void> {
  const remoteBase = `${docroot}/${PLUGIN_REMOTE_DIR}`;

  const dirs = new Set<string>();
  for (const relativePath of Object.keys(COMPANION_PLUGIN_FILES)) {
    const dir = path.dirname(relativePath);
    if (dir !== '.') {
      dirs.add(dir);
    }
  }

  await sftp.mkdirp(remoteBase);
  for (const dir of dirs) {
    await sftp.mkdirp(`${remoteBase}/${dir}`);
  }

  for (const [relativePath, content] of Object.entries(COMPANION_PLUGIN_FILES)) {
    const remotePath = `${remoteBase}/${relativePath}`;
    const tmpLocal = path.join(
      os.tmpdir(),
      `localdock-companion-${Date.now()}-${Math.random().toString(36).slice(2)}.php`
    );
    await fs.writeFile(tmpLocal, content, 'utf-8');
    try {
      await sftp.fastPut(tmpLocal, remotePath);
    } finally {
      await fs.unlink(tmpLocal).catch(() => {});
    }
  }
}

async function tryActivateViaWpCli(docroot: string, ssh: SshClient): Promise<boolean> {
  const findWp = await ssh.exec('command -v wp || true');
  if (!findWp.stdout.trim()) {
    logger.info('[CompanionProvisioner] wp-cli not found on PATH — skipping automatic activation');
    return false;
  }

  const escapedDocroot = docroot.replace(/'/g, "'\\''");
  const activate = await ssh.exec(`wp plugin activate localdock-companion --path='${escapedDocroot}' 2>&1`);
  if (activate.code !== 0) {
    logger.warn(`[CompanionProvisioner] wp-cli activation failed: ${activate.stdout}${activate.stderr}`);
    return false;
  }
  return true;
}

/** Escape a string for embedding inside a PHP single-quoted string literal. */
function escapePhpSingleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Activation fallback that doesn't depend on wp-cli: bootstraps WordPress via
 * its own wp-load.php over a plain PHP CLI call and invokes activate_plugin()
 * directly — the same function wp-admin's "Activate" link and wp-cli itself
 * both call under the hood, so it fires the plugin's register_activation_hook
 * (which is what generates the API key) exactly the same way.
 */
async function tryActivateViaPhpCli(docroot: string, ssh: SshClient, sftp: SftpClient): Promise<boolean> {
  const script = [
    '<?php',
    `$docroot = '${escapePhpSingleQuoted(docroot)}';`,
    "require $docroot . '/wp-load.php';",
    "if (!function_exists('activate_plugin')) { require_once ABSPATH . 'wp-admin/includes/plugin.php'; }",
    "$result = activate_plugin('localdock-companion/localdock-companion.php');",
    'if (is_wp_error($result)) { fwrite(STDERR, $result->get_error_message()); exit(1); }',
    "echo 'LOCALDOCK_ACTIVATED';",
  ].join('\n');

  const stamp = Date.now();
  const localTmp = path.join(os.tmpdir(), `localdock_companion_activate_${stamp}.php`);
  const remoteTmp = `/tmp/localdock_companion_activate_${stamp}.php`;

  await fs.writeFile(localTmp, script, 'utf-8');
  try {
    await sftp.fastPut(localTmp, remoteTmp);

    const result = await ssh.exec(`php ${remoteTmp}`);
    if (result.code !== 0 || !result.stdout.includes('LOCALDOCK_ACTIVATED')) {
      logger.warn(`[CompanionProvisioner] PHP CLI activation failed: ${result.stdout}${result.stderr}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(`[CompanionProvisioner] PHP CLI activation errored: ${(err as Error).message}`);
    return false;
  } finally {
    await fs.unlink(localTmp).catch(() => {});
    await ssh.exec(`rm -f ${remoteTmp}`).catch(() => {});
  }
}

/**
 * Reads the plugin's generated API key straight from wp_options via a
 * read-only SELECT. Auto-detects the table prefix (many hosts use something
 * other than "wp_") the same way DatabaseSyncer.fixUrlsOnServer does, since
 * we can't assume the plugin's own admin page has ever been visited.
 */
async function fetchApiKeyFromDb(
  site: WordPressSite,
  dbPass: string,
  ssh: SshClient,
  sftp: SftpClient
): Promise<string | undefined> {
  if (!isValidDbIdentifier(site.dbName)) {
    throw new LocalDockError(
      `Invalid database name: ${site.dbName}`,
      LocalDockErrorCode.DB_EXPORT_FAILED,
      false
    );
  }
  if (!isValidDbIdentifier(site.dbUser)) {
    throw new LocalDockError(
      `Invalid database user: ${site.dbUser}`,
      LocalDockErrorCode.DB_EXPORT_FAILED,
      false
    );
  }
  if (!isValidDbHost(site.dbHost)) {
    throw new LocalDockError(
      `Invalid database host: ${site.dbHost}`,
      LocalDockErrorCode.DB_EXPORT_FAILED,
      false
    );
  }

  const sql = [
    "SET @tbl := (SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE '%\\_options' LIMIT 1);",
    "SET @sql := CONCAT('SELECT option_value FROM ', @tbl, ' WHERE option_name=''localdock_api_key'' LIMIT 1');",
    'PREPARE stmt FROM @sql;',
    'EXECUTE stmt;',
    'DEALLOCATE PREPARE stmt;',
  ].join('\n');

  const stamp = Date.now();
  const localTmp = path.join(os.tmpdir(), `localdock_companion_key_${stamp}.sql`);
  const remoteTmp = `/tmp/localdock_companion_key_${stamp}.sql`;

  const { host, port } = parseDbHost(site.dbHost);

  await fs.writeFile(localTmp, sql, 'utf-8');
  try {
    await sftp.fastPut(localTmp, remoteTmp);

    const escapedPass = dbPass.replace(/'/g, "'\\''");
    const cmd = `MYSQL_PWD='${escapedPass}' mysql -h${host} -P${port} -u${site.dbUser} -N ${site.dbName} < ${remoteTmp}`;
    const result = await ssh.exec(cmd);

    if (result.code !== 0) {
      logger.warn(`[CompanionProvisioner] API key lookup query failed: ${result.stderr}`);
      return undefined;
    }
    return result.stdout.trim() || undefined;
  } finally {
    await fs.unlink(localTmp).catch(() => {});
    await ssh.exec(`rm -f ${remoteTmp}`).catch(() => {});
  }
}

/** Split a DB_HOST value that may contain an embedded port (e.g. "localhost:3306") */
function parseDbHost(dbHost: string): { host: string; port: string } {
  if (dbHost.startsWith('[')) {
    const closeBracket = dbHost.indexOf(']');
    if (closeBracket > -1 && dbHost[closeBracket + 1] === ':') {
      return { host: dbHost.substring(0, closeBracket + 1), port: dbHost.substring(closeBracket + 2) };
    }
    return { host: dbHost, port: '3306' };
  }
  const idx = dbHost.lastIndexOf(':');
  if (idx > -1) {
    return { host: dbHost.substring(0, idx), port: dbHost.substring(idx + 1) };
  }
  return { host: dbHost, port: '3306' };
}
