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
    onProgress?: (message: string) => void
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

    // Upload dump
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
   * Handles PHP serialized strings by recalculating byte-length prefixes.
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
        let out = line;

        // Replace PHP serialized strings: s:XX:"http://old.com" → s:YY:"http://new.com"
        out = out.replace(/s:(\d+):"([^"]*?)"/g, (_match, lenStr, str) => {
          if (!str.includes(from)) { return _match; }
          const replaced = str.replace(new RegExp(escapeRegExp(from), 'g'), to);
          const newLen = Buffer.byteLength(replaced, 'utf-8');
          return `s:${newLen}:"${replaced}"`;
        });

        // Replace plain string occurrences outside serialized context
        if (out.includes(from)) {
          out = out.replace(new RegExp(escapeRegExp(from), 'g'), to);
        }

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
