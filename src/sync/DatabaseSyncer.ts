import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import * as util from 'util';
import * as readline from 'readline';
import { SshClient } from '../api/SshClient';
import { SftpClient } from '../api/SftpClient';
import { WordPressSite } from '../models/Site';
import { logger } from '../utils/logger';
import { isValidDbIdentifier, sanitizeDbName } from '../utils/pathUtils';
import { LocalDockError, LocalDockErrorCode } from '../utils/errors';

const exec = util.promisify(child_process.exec);

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
}

export class DatabaseSyncer {
  constructor(
    private readonly ssh: SshClient,
    private readonly sftp: SftpClient,
    private readonly localDb: DbConfig
  ) {}

  /** Export remote DB and download it locally, then import into local MySQL if configured */
  async pullDatabase(
    site: WordPressSite,
    localSitePath: string,
    onProgress?: (message: string) => void
  ): Promise<void> {
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

    const tmpRemote = `/tmp/localdock_${site.dbName}_${Date.now()}.sql`;
    const localDockDir = path.join(localSitePath, '.localdock');
    const localSqlPath = path.join(localDockDir, 'db.sql');

    await fs.mkdir(localDockDir, { recursive: true });

    // Dump on remote — use MYSQL_PWD env var to avoid password in process list
    onProgress?.('Exporting database…');
    logger.info(`[DatabaseSyncer] Dumping ${site.dbName} on ${site.dbHost}`);

    const { host: dbHost, port: dbPort } = this.parseDbHost(site.dbHost);
    const dumpCmd =
      `MYSQL_PWD='${site.dbPass.replace(/'/g, "'\\''")}' ` +
      `mysqldump -h${dbHost} -P${dbPort} -u${site.dbUser} ` +
      `--single-transaction --routines --triggers ${site.dbName} > ${tmpRemote}`;

    const dumpResult = await this.ssh.exec(dumpCmd);
    if (dumpResult.code !== 0) {
      throw new LocalDockError(
        `mysqldump failed: ${dumpResult.stderr}`,
        LocalDockErrorCode.DB_EXPORT_FAILED,
        true
      );
    }

    // Download dump
    onProgress?.('Downloading database dump…');
    await this.sftp.fastGet(tmpRemote, localSqlPath);
    logger.info(`[DatabaseSyncer] Database dump saved to ${localSqlPath}`);

    // Cleanup remote temp file
    await this.ssh.exec(`rm -f ${tmpRemote}`).catch((err) => {
      logger.warn(`[DatabaseSyncer] Failed to cleanup temp file: ${err.message}`);
    });

    // Import into local MySQL if configured
    if (this.localDb.password !== undefined) {
      onProgress?.('Importing database locally…');
      const localDbName = sanitizeDbName(site.domain);
      await this.importLocalDb(localDbName, localSqlPath);
    }
  }

  /** Re-export local DB and push to remote server */
  async pushDatabase(
    site: WordPressSite,
    localSitePath: string,
    onProgress?: (message: string) => void,
    sourceSqlPath?: string
  ): Promise<void> {
    if (!isValidDbIdentifier(site.dbName)) {
      throw new LocalDockError(
        `Invalid database name: ${site.dbName}`,
        LocalDockErrorCode.DB_IMPORT_FAILED,
        false
      );
    }
    if (!isValidDbIdentifier(site.dbUser)) {
      throw new LocalDockError(
        `Invalid database user: ${site.dbUser}`,
        LocalDockErrorCode.DB_IMPORT_FAILED,
        false
      );
    }

    const localSqlPath = sourceSqlPath ?? path.join(localSitePath, '.localdock', 'db.sql');
    const tmpRemote = `/tmp/localdock_push_${site.dbName}_${Date.now()}.sql`;

    // Re-export from local MySQL only if no Docker dump was provided
    if (!sourceSqlPath && this.localDb.password !== undefined) {
      onProgress?.('Exporting local database…');
      const localDbName = sanitizeDbName(site.domain);
      await this.exportLocalDb(localDbName, localSqlPath);
    }

    // Check that we have a dump to push
    try {
      await fs.stat(localSqlPath);
    } catch {
      throw new LocalDockError(
        'No local database dump found. Pull the site first.',
        LocalDockErrorCode.DB_IMPORT_FAILED,
        false
      );
    }

    // Upload dump with localhost URLs intact — URL rewriting happens after import
    // via fixUrlsOnServer() which uses PHP's own serialize/unserialize to avoid
    // corrupting byte counts in PHP serialized options like astra-settings.
    onProgress?.('Uploading database dump…');
    await this.sftp.fastPut(localSqlPath, tmpRemote);

    // Import on remote
    onProgress?.('Importing database on server…');
    logger.info(`[DatabaseSyncer] Importing ${site.dbName} on ${site.dbHost}`);

    const { host: dbHost, port: dbPort } = this.parseDbHost(site.dbHost);
    const importCmd =
      `MYSQL_PWD='${site.dbPass.replace(/'/g, "'\\''")}' ` +
      `mysql -h${dbHost} -P${dbPort} -u${site.dbUser} ${site.dbName} < ${tmpRemote}`;

    const importResult = await this.ssh.exec(importCmd);

    // Cleanup remote temp file
    await this.ssh.exec(`rm -f ${tmpRemote}`).catch((err) => {
      logger.warn(`[DatabaseSyncer] Failed to cleanup temp file: ${err.message}`);
    });

    if (importResult.code !== 0) {
      throw new LocalDockError(
        `MySQL import failed: ${importResult.stderr}`,
        LocalDockErrorCode.DB_IMPORT_FAILED,
        true
      );
    }
  }

  /**
   * Replace localhost URLs with the production URL on the server using PHP's own
   * unserialize/serialize so byte counts in PHP serialized options (astra-settings,
   * theme-mods, etc.) are always correct. Raw SQL text replacement corrupts these
   * counts and causes unserialize() to return false, resetting all customizer settings.
   *
   * Generates a minimal PHP script, uploads it to /tmp on the server, runs it via SSH,
   * then removes it. Handles both serialized and plain-string option values.
   */
  async fixUrlsOnServer(
    site: WordPressSite,
    localUrl: string,
    productionUrl: string,
    onProgress?: (message: string) => void
  ): Promise<void> {
    const from = localUrl.replace(/\/$/, '');
    const to = productionUrl.replace(/\/$/, '');
    if (!from || !to || from === to) { return; }

    onProgress?.('Rewriting production URLs…');
    logger.info(`[DatabaseSyncer] fixUrlsOnServer: ${from} → ${to}`);

    // Detect PHP binary across common cPanel EasyApache paths
    const { host: dbHost, port: dbPort } = this.parseDbHost(site.dbHost);
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    // Wrap everything in try/catch so errors always produce output even with display_errors=Off
    const script = `<?php
ini_set('display_errors','1');
try {
$pdo=new PDO('mysql:host=${esc(dbHost)};port=${dbPort};dbname=${esc(site.dbName)};charset=utf8mb4','${esc(site.dbUser)}','${esc(site.dbPass)}',array(PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION));
$f='${esc(from)}';$t='${esc(to)}';
// Auto-detect table prefix by finding the *_options table
$tbl=$pdo->query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE '%_options' LIMIT 1")->fetchColumn();
if(!$tbl){throw new Exception('Could not find WordPress options table');}
$pfx=substr($tbl,0,strlen($tbl)-7);
function ld_r($d,$f,$t){
  if(is_array($d)){$o=array();foreach($d as $k=>$v){$o[is_string($k)?str_replace($f,$t,$k):$k]=ld_r($v,$f,$t);}return $o;}
  if(is_object($d)){if(get_class($d)==='__PHP_Incomplete_Class'){return $d;}foreach(get_object_vars($d)as $k=>$v){$d->$k=ld_r($v,$f,$t);}return $d;}
  return is_string($d)?str_replace($f,$t,$d):$d;
}
function ld_fix($pdo,$table,$id,$val,$f,$t){
  $s=$pdo->prepare("SELECT $id,$val FROM $table WHERE $val LIKE ?");
  $s->execute(array('%'.$f.'%'));$n=0;
  foreach($s->fetchAll(PDO::FETCH_OBJ)as $r){
    $raw=$r->$val;$dec=@unserialize($raw);
    $new=($dec!==false||$raw==='b:0;')?serialize(ld_r($dec,$f,$t)):str_replace($f,$t,$raw);
    if($new!==$raw){$u=$pdo->prepare("UPDATE $table SET $val=? WHERE $id=?");$u->execute(array($new,$r->$id));$n++;}
  }
  return $n;
}
$n=ld_fix($pdo,$pfx.'options','option_name','option_value',$f,$t);
$n+=ld_fix($pdo,$pfx.'postmeta','meta_id','meta_value',$f,$t);
echo "ok:".$n;
} catch(Exception $e){echo "error:".$e->getMessage();exit(1);}
`;

    const stamp = Date.now();
    const localTmp = path.join(os.tmpdir(), `localdock_urlfix_${stamp}.php`);
    const remoteTmp = `/tmp/localdock_urlfix_${stamp}.php`;

    await fs.writeFile(localTmp, script, 'utf-8');
    try {
      await this.sftp.fastPut(localTmp, remoteTmp);

      // Step 1: find PHP binary (separate exec so we can log what was found)
      const findCmd =
        `PHP_BIN=""; ` +
        `for p in php php8 php82 php81 php80 php74 /usr/local/bin/php /usr/bin/php; do ` +
        `  command -v "$p" >/dev/null 2>&1 && PHP_BIN=$(command -v "$p") && break; ` +
        `done; ` +
        `if [ -z "$PHP_BIN" ]; then ` +
        `  for f in /opt/cpanel/ea-php*/root/usr/bin/php; do ` +
        `    [ -x "$f" ] && PHP_BIN="$f" && break; ` +
        `  done; ` +
        `fi; ` +
        `echo "$PHP_BIN"`;

      const findResult = await this.ssh.exec(findCmd);
      const phpBin = findResult.stdout.trim();
      logger.info(`[DatabaseSyncer] fixUrlsOnServer PHP binary: "${phpBin || '(none found)'}"`);

      if (!phpBin) {
        throw new LocalDockError(
          'No PHP binary found on the server. Contact your host to add PHP to your SSH PATH.',
          LocalDockErrorCode.DB_IMPORT_FAILED,
          true
        );
      }

      // Step 2: run script with the found binary
      const result = await this.ssh.exec(`"${phpBin}" ${remoteTmp} 2>&1`);
      const out = result.stdout.trim();
      logger.info(`[DatabaseSyncer] fixUrlsOnServer PHP output: "${out}"`);

      if (!out.startsWith('ok')) {
        throw new LocalDockError(
          `Production URL rewrite failed: ${out || result.stderr.trim() || '(no output)'}`,
          LocalDockErrorCode.DB_IMPORT_FAILED,
          true
        );
      }
      const count = out.split(':')[1] ?? '?';
      logger.info(`[DatabaseSyncer] fixUrlsOnServer: updated ${count} rows`);
    } finally {
      await fs.unlink(localTmp).catch(() => {});
      await this.ssh.exec(`rm -f ${remoteTmp}`).catch(() => {});
    }
  }

  private async importLocalDb(dbName: string, sqlPath: string): Promise<void> {
    const { host, port, user, password } = this.localDb;
    const env = { ...process.env, MYSQL_PWD: password ?? '' };

    try {
      // Create DB if not exists
      await exec(
        `mysql -h${host} -P${port} -u${user} -e "CREATE DATABASE IF NOT EXISTS \`${dbName}\`"`,
        { env }
      );
      // Import
      await exec(
        `mysql -h${host} -P${port} -u${user} ${dbName} < "${sqlPath}"`,
        { env }
      );
      logger.info(`[DatabaseSyncer] Imported into local DB: ${dbName}`);
    } catch (err) {
      logger.warn(
        `[DatabaseSyncer] Local DB import failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /**
   * Rewrite WordPress siteurl/home values in a SQL dump from production URL to local URL.
   * Handles PHP serialized strings by using the byte-length prefix to extract content,
   * so strings containing embedded double quotes (e.g. CSS values) are handled correctly.
   * Streams the file to avoid loading large dumps into memory.
   */
  static async rewriteUrlsInDump(sqlPath: string, fromUrl: string, toUrl: string): Promise<void> {
    // Normalize URLs (strip trailing slash)
    const from = fromUrl.replace(/\/$/, '');
    const to = toUrl.replace(/\/$/, '');

    if (from === to) { return; }

    logger.info(`[DatabaseSyncer] Rewriting URLs in dump: ${from} → ${to}`);

    const tmpPath = sqlPath + '.tmp';

    const inputStream = fsSync.createReadStream(sqlPath, { encoding: 'utf-8' });
    const outputStream = fsSync.createWriteStream(tmpPath, { encoding: 'utf-8' });

    const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });

    await new Promise<void>((resolve, reject) => {
      outputStream.on('error', reject);
      rl.on('error', reject);

      rl.on('line', (line) => {
        const out = DatabaseSyncer.rewriteLineUrls(line, from, to);
        outputStream.write(out + '\n');
      });

      rl.on('close', () => {
        outputStream.end();
      });

      outputStream.on('finish', resolve);
    });

    // Replace original with rewritten file
    await fs.rename(tmpPath, sqlPath);
    logger.info(`[DatabaseSyncer] URL rewrite complete`);
  }

  /**
   * Rewrite all occurrences of `from` → `to` in a single SQL dump line.
   *
   * PHP serialized strings use `s:N:"<content>"` where N is the BYTE length of
   * the content. A naive regex like `[^"]*?` stops at the first embedded double
   * quote, producing a wrong length and corrupting the entire serialized value
   * (which causes PHP's unserialize() to return false for the whole option,
   * reverting ALL theme-mod/customizer settings to defaults).
   *
   * This method finds each `s:N:"` marker, reads exactly N bytes from the raw
   * buffer to get the true content (embedded quotes included), rewrites any URLs
   * inside, recalculates the byte length, and reconstructs the token. Any
   * remaining plain-text occurrences (JSON, non-serialized values) are replaced
   * with a simple string replace afterward.
   */
  static rewriteLineUrls(line: string, from: string, to: string): string {
    if (!line.includes(from)) { return line; }

    const fromRe = new RegExp(escapeRegExp(from), 'g');
    const lineBuf = Buffer.from(line, 'utf-8');

    let result = '';
    let charPos = 0;
    const sPattern = /s:(\d+):"/g;
    let m: RegExpExecArray | null;

    while ((m = sPattern.exec(line)) !== null) {
      const matchCharStart = m.index;
      const byteLen = parseInt(m[1], 10);
      const contentCharStart = matchCharStart + m[0].length;

      // Locate content start in bytes
      const byteContentStart = Buffer.byteLength(line.slice(0, contentCharStart), 'utf-8');

      // Guard against malformed s:N:" where N exceeds the buffer
      if (byteContentStart + byteLen > lineBuf.length) { continue; }

      // Extract exactly byteLen bytes — correctly handles embedded " and multi-byte chars
      const contentBuf = lineBuf.slice(byteContentStart, byteContentStart + byteLen);
      const content = contentBuf.toString('utf-8');

      // Verify closing quote sits immediately after the declared byte span
      const closingCharPos = contentCharStart + content.length;
      if (line[closingCharPos] !== '"') { continue; }

      // Append everything from the last processed position up to this token
      result += line.slice(charPos, matchCharStart);

      if (content.includes(from)) {
        const replaced = content.replace(fromRe, to);
        result += `s:${Buffer.byteLength(replaced, 'utf-8')}:"${replaced}"`;
      } else {
        result += `s:${byteLen}:"${content}"`;
      }

      charPos = closingCharPos + 1;
      sPattern.lastIndex = charPos;
    }

    // Append the tail of the line after the last serialized token
    result += line.slice(charPos);

    // Replace any remaining plain-text occurrences (JSON, unquoted SQL values, etc.)
    if (result.includes(from)) {
      result = result.replace(fromRe, to);
    }

    return result;
  }

  /**
   * Strip CREATE DATABASE, DROP DATABASE, and USE statements from a SQL dump so it
   * imports into whichever database MySQL already has selected (e.g. the Docker default).
   */
  static async stripDatabaseStatements(sqlPath: string): Promise<void> {
    const tmpPath = sqlPath + '.tmp';
    const inputStream = fsSync.createReadStream(sqlPath, { encoding: 'utf-8' });
    const outputStream = fsSync.createWriteStream(tmpPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });

    await new Promise<void>((resolve, reject) => {
      outputStream.on('error', reject);
      rl.on('error', reject);
      rl.on('line', (line) => {
        const t = line.trimStart();
        if (
          /^CREATE\s+DATABASE\b/i.test(t) ||
          /^DROP\s+DATABASE\b/i.test(t) ||
          /^USE\s+`[^`]+`\s*;/i.test(t)
        ) { return; }
        outputStream.write(line + '\n');
      });
      rl.on('close', () => outputStream.end());
      outputStream.on('finish', resolve);
    });

    await fs.rename(tmpPath, sqlPath);
    logger.info('[DatabaseSyncer] Stripped database statements from dump');
  }

  /**
   * Append a sentinel table to the end of a SQL dump file.
   * The healthcheck queries for this table to confirm the full import is done.
   * Idempotent — safe to call if the sentinel is already present.
   */
  static async appendSentinel(sqlPath: string): Promise<void> {
    const sentinel =
      '\n-- LocalDock initialization sentinel (do not remove)\n' +
      'CREATE TABLE IF NOT EXISTS `_localdock_ready` (`id` tinyint(1) NOT NULL DEFAULT \'1\');\n' +
      'INSERT IGNORE INTO `_localdock_ready` (`id`) VALUES (1);\n';
    await fs.appendFile(sqlPath, sentinel, 'utf-8');
    logger.info('[DatabaseSyncer] Appended initialization sentinel to db.sql');
  }

  /** Split a DB_HOST value that may contain an embedded port (e.g. "localhost:3306") */
  private parseDbHost(dbHost: string): { host: string; port: string } {
    // Guard against IPv6 addresses like "[::1]:3306"
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

  private async exportLocalDb(dbName: string, sqlPath: string): Promise<void> {
    const { host, port, user, password } = this.localDb;
    const env = { ...process.env, MYSQL_PWD: password ?? '' };

    await exec(
      `mysqldump -h${host} -P${port} -u${user} --single-transaction ${dbName} > "${sqlPath}"`,
      { env }
    );
    logger.info(`[DatabaseSyncer] Exported local DB: ${dbName}`);
  }
}
