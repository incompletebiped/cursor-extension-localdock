import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
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
    localUrl?: string,
    productionUrl?: string
  ): Promise<void> {
    if (!isValidDbIdentifier(site.dbName)) {
      throw new LocalDockError(
        `Invalid database name: ${site.dbName}`,
        LocalDockErrorCode.DB_IMPORT_FAILED,
        false
      );
    }

    const localSqlPath = path.join(localSitePath, '.localdock', 'db.sql');
    const tmpRemote = `/tmp/localdock_push_${site.dbName}_${Date.now()}.sql`;

    // Re-export from local MySQL if we have local DB credentials
    if (this.localDb.password !== undefined) {
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

    // Rewrite localhost URLs back to production before uploading
    let uploadPath = localSqlPath;
    let rewrittenDump: string | null = null;
    if (localUrl && productionUrl && localUrl !== productionUrl) {
      onProgress?.('Rewriting database URLs for production…');
      rewrittenDump = localSqlPath + '.push.tmp';
      await fs.copyFile(localSqlPath, rewrittenDump);
      await DatabaseSyncer.rewriteUrlsInDump(rewrittenDump, localUrl, productionUrl);
      uploadPath = rewrittenDump;
    }

    // Upload dump
    onProgress?.('Uploading database dump…');
    try {
      await this.sftp.fastPut(uploadPath, tmpRemote);
    } finally {
      if (rewrittenDump) {
        await fs.unlink(rewrittenDump).catch(() => {});
      }
    }

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
