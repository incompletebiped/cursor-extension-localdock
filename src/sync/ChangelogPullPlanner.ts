import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SshClient } from '../api/SshClient';
import { SftpClient } from '../api/SftpClient';
import { WordPressSite } from '../models/Site';
import { DockerManager } from '../docker/DockerManager';
import { ChangelogPushPlan, escapeSqlString } from './ChangelogPushPlanner';
import { isValidDbIdentifier, isValidDbHost } from '../utils/pathUtils';
import { LocalDockError, LocalDockErrorCode } from '../utils/errors';
import { logger } from '../utils/logger';

export type DbConflictKind = 'option' | 'post' | 'user';

export interface DbPullConflict {
  kind: DbConflictKind;
  key: string | number;
}

export interface DbPullPlan {
  safeOptionNames: string[];
  safePostIds: number[];
  safeUserIds: number[];
  conflicts: DbPullConflict[];
  isEmpty: boolean;
}

/**
 * Combines what changed on the server since the last pull with what changed
 * locally since the last pull (both from Companion changelogs) to decide
 * what's safe to bring into the local database automatically versus what
 * needs a decision because both sides touched the same row — e.g. a plugin
 * update changed an option on the server, but you also have local changes to
 * that same option since your last pull.
 */
export function mergeDatabasePullPlan(remotePlan: ChangelogPushPlan, localPlan: ChangelogPushPlan): DbPullPlan {
  const localOptions = new Set(localPlan.optionNames);
  const localPosts = new Set(localPlan.postIds);
  const localUsers = new Set(localPlan.userIds);

  const safeOptionNames: string[] = [];
  const safePostIds: number[] = [];
  const safeUserIds: number[] = [];
  const conflicts: DbPullConflict[] = [];

  for (const name of remotePlan.optionNames) {
    if (localOptions.has(name)) {
      conflicts.push({ kind: 'option', key: name });
    } else {
      safeOptionNames.push(name);
    }
  }
  for (const id of remotePlan.postIds) {
    if (localPosts.has(id)) {
      conflicts.push({ kind: 'post', key: id });
    } else {
      safePostIds.push(id);
    }
  }
  for (const id of remotePlan.userIds) {
    if (localUsers.has(id)) {
      conflicts.push({ kind: 'user', key: id });
    } else {
      safeUserIds.push(id);
    }
  }

  return {
    safeOptionNames,
    safePostIds,
    safeUserIds,
    conflicts,
    isEmpty: safeOptionNames.length === 0 && safePostIds.length === 0 && safeUserIds.length === 0,
  };
}

interface DbRowKeys {
  optionNames: string[];
  postIds: number[];
  userIds: number[];
}

/** Builds a minimal SQL script covering exactly `keys`, reading current row
 * content from the REMOTE database over SSH — the changelog only records
 * which rows changed, not their content. */
export async function fetchRemoteDatabaseRows(
  ssh: SshClient,
  sftp: SftpClient,
  site: WordPressSite,
  keys: DbRowKeys
): Promise<string> {
  if (!isValidDbIdentifier(site.dbName) || !isValidDbIdentifier(site.dbUser) || !isValidDbHost(site.dbHost)) {
    throw new LocalDockError('Invalid database name, user, or host — refusing to pull.', LocalDockErrorCode.DB_EXPORT_FAILED, false);
  }

  const prefix = await detectRemoteTablePrefix(ssh, site);
  const parts: string[] = [];

  if (keys.optionNames.length > 0) {
    parts.push(await fetchRemoteOptionsSql(ssh, sftp, site, prefix, keys.optionNames));
  }
  if (keys.postIds.length > 0) {
    parts.push(await syncRemoteRows(ssh, sftp, site, `${prefix}posts`, `${prefix}postmeta`, 'post_id', 'ID', keys.postIds));
  }
  if (keys.userIds.length > 0) {
    parts.push(await syncRemoteRows(ssh, sftp, site, `${prefix}users`, `${prefix}usermeta`, 'user_id', 'ID', keys.userIds));
  }

  return parts.filter(Boolean).join('\n');
}

/** Applies a script built by fetchRemoteDatabaseRows() to the local Docker database. */
export async function applyDatabasePullSql(dockerManager: DockerManager, localSitePath: string, sqlText: string): Promise<void> {
  if (!sqlText.trim()) {
    return;
  }
  const result = await dockerManager.execInServiceWithInput(
    localSitePath,
    'db',
    ['mysql', '-uwordpress', '-pwordpress', 'wordpress'],
    sqlText
  );
  if (result.code !== 0) {
    throw new Error(`Applying pulled database changes locally failed: ${result.stderr.trim() || '(no stderr)'}`);
  }
}

async function detectRemoteTablePrefix(ssh: SshClient, site: WordPressSite): Promise<string> {
  const table = (await runRemoteQuery(ssh, site,
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE '%\\_options' LIMIT 1"
  )).trim();

  if (!/^[A-Za-z0-9_]+options$/.test(table)) {
    logger.warn(`[ChangelogPullPlanner] Could not resolve remote table prefix (got "${table}") — assuming "wp_"`);
    return 'wp_';
  }
  return table.slice(0, -'options'.length);
}

/** A static, non-interpolated query is safe to embed directly — used only for the prefix probe above. */
async function runRemoteQuery(ssh: SshClient, site: WordPressSite, sql: string): Promise<string> {
  const { host, port } = parseDbHost(site.dbHost);
  const escPass = site.dbPass.replace(/'/g, "'\\''");
  const cmd = `MYSQL_PWD='${escPass}' mysql -h${host} -P${port} -u${site.dbUser} ${site.dbName} -N -B -e "${sql}"`;
  const result = await ssh.exec(cmd);
  if (result.code !== 0) {
    throw new Error(`Remote query failed: ${result.stderr.trim() || '(no stderr)'}`);
  }
  return result.stdout;
}

/**
 * Runs SQL containing option-name-derived content by writing it to a file
 * and redirecting it in (`mysql ... < file`) instead of embedding it in a
 * shell command string — avoids shell-escaping entirely for data that isn't
 * purely-numeric, the same pattern DatabaseSyncer.pushDatabase() already uses.
 */
async function runRemoteSqlFile(ssh: SshClient, sftp: SftpClient, site: WordPressSite, sql: string): Promise<string> {
  const { host, port } = parseDbHost(site.dbHost);
  const stamp = Date.now();
  const localTmp = path.join(os.tmpdir(), `localdock_pull_query_${stamp}.sql`);
  const remoteTmp = `/tmp/localdock_pull_query_${stamp}.sql`;

  await fs.writeFile(localTmp, sql, 'utf-8');
  try {
    await sftp.fastPut(localTmp, remoteTmp);

    const escPass = site.dbPass.replace(/'/g, "'\\''");
    const cmd = `MYSQL_PWD='${escPass}' mysql -h${host} -P${port} -u${site.dbUser} -N -B ${site.dbName} < ${remoteTmp}`;
    const result = await ssh.exec(cmd);

    await ssh.exec(`rm -f ${remoteTmp}`).catch((err) => {
      logger.warn(`[ChangelogPullPlanner] Failed to cleanup remote temp file: ${err.message}`);
    });

    if (result.code !== 0) {
      throw new Error(`Remote query failed: ${result.stderr.trim() || '(no stderr)'}`);
    }
    return result.stdout;
  } finally {
    await fs.unlink(localTmp).catch(() => {});
  }
}

async function fetchRemoteOptionsSql(
  ssh: SshClient,
  sftp: SftpClient,
  site: WordPressSite,
  prefix: string,
  optionNames: string[]
): Promise<string> {
  const inList = optionNames.map((n) => `'${escapeSqlString(n)}'`).join(',');
  const raw = await runRemoteSqlFile(
    ssh, sftp, site,
    `SELECT option_name, HEX(option_value), autoload FROM ${prefix}options WHERE option_name IN (${inList});`
  );

  const found = new Set<string>();
  const lines: string[] = [];

  for (const row of raw.split('\n')) {
    if (!row.trim()) {
      continue;
    }
    const [name, hexValue, autoload] = row.split('\t');
    if (!name) {
      continue;
    }
    found.add(name);
    lines.push(
      `INSERT INTO ${prefix}options (option_name, option_value, autoload) VALUES ('${escapeSqlString(name)}', UNHEX('${hexValue ?? ''}'), '${escapeSqlString(autoload ?? 'yes')}') ` +
        `ON DUPLICATE KEY UPDATE option_value=VALUES(option_value), autoload=VALUES(autoload);`
    );
  }

  for (const name of optionNames) {
    if (!found.has(name)) {
      lines.push(`DELETE FROM ${prefix}options WHERE option_name='${escapeSqlString(name)}';`);
    }
  }

  return lines.join('\n');
}

/** Syncs rows (by numeric primary key) plus their meta table from the remote:
 * still-present rows are copied verbatim via mysqldump, rows no longer
 * present remotely are deleted locally. */
async function syncRemoteRows(
  ssh: SshClient,
  sftp: SftpClient,
  site: WordPressSite,
  mainTable: string,
  metaTable: string,
  metaFkColumn: string,
  pkColumn: string,
  ids: number[]
): Promise<string> {
  const safeIds = ids.filter((id) => Number.isInteger(id));
  if (safeIds.length !== ids.length) {
    logger.warn(`[ChangelogPullPlanner] Dropped non-integer id(s) for ${mainTable}`);
  }
  if (safeIds.length === 0) {
    return '';
  }

  const idList = safeIds.join(',');
  const existingRaw = await runRemoteSqlFile(ssh, sftp, site, `SELECT ${pkColumn} FROM ${mainTable} WHERE ${pkColumn} IN (${idList});`);
  const existingIds = existingRaw.split('\n').map((l) => l.trim()).filter(Boolean).map(Number);
  const existingSet = new Set(existingIds);
  const missingIds = safeIds.filter((id) => !existingSet.has(id));

  const parts: string[] = [];

  if (missingIds.length > 0) {
    const missingList = missingIds.join(',');
    parts.push(`DELETE FROM ${metaTable} WHERE ${metaFkColumn} IN (${missingList});`);
    parts.push(`DELETE FROM ${mainTable} WHERE ${pkColumn} IN (${missingList});`);
  }

  if (existingIds.length > 0) {
    const existingList = existingIds.join(',');
    const mainDump = await dumpRemoteTable(ssh, site, mainTable, `${pkColumn} IN (${existingList})`);
    const metaDump = await dumpRemoteTable(ssh, site, metaTable, `${metaFkColumn} IN (${existingList})`);
    if (mainDump.trim()) {
      parts.push(mainDump);
    }
    if (metaDump.trim()) {
      parts.push(metaDump);
    }
  }

  return parts.join('\n');
}

async function dumpRemoteTable(ssh: SshClient, site: WordPressSite, table: string, whereClause: string): Promise<string> {
  const { host, port } = parseDbHost(site.dbHost);
  const escPass = site.dbPass.replace(/'/g, "'\\''");
  const cmd =
    `MYSQL_PWD='${escPass}' mysqldump -h${host} -P${port} -u${site.dbUser} ` +
    `--single-transaction --no-tablespaces --no-create-info --skip-add-locks ` +
    `--where="${whereClause}" ${site.dbName} ${table}`;
  const result = await ssh.exec(cmd);
  if (result.code !== 0) {
    throw new Error(`Remote mysqldump of ${table} failed: ${result.stderr.trim() || '(no stderr)'}`);
  }
  return result.stdout;
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
