import * as fs from 'fs/promises';
import * as path from 'path';
import * as child_process from 'child_process';
import * as util from 'util';
import { SshClient } from '../api/SshClient';
import { SftpClient } from '../api/SftpClient';
import { WordPressSite } from '../models/Site';
import { logger } from '../utils/logger';
import { isValidDbIdentifier, sanitizeDbName } from '../utils/pathUtils';
import { LocalWPError, LocalWPErrorCode } from '../utils/errors';

const exec = util.promisify(child_process.exec);

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
      throw new LocalWPError(
        `Invalid database name: ${site.dbName}`,
        LocalWPErrorCode.DB_EXPORT_FAILED,
        false
      );
    }

    const tmpRemote = `/tmp/localwp_${site.dbName}_${Date.now()}.sql`;
    const localWpDir = path.join(localSitePath, '.localwp');
    const localSqlPath = path.join(localWpDir, 'db.sql');

    await fs.mkdir(localWpDir, { recursive: true });

    // Dump on remote — use MYSQL_PWD env var to avoid password in process list
    onProgress?.('Exporting database…');
    logger.info(`[DatabaseSyncer] Dumping ${site.dbName} on ${site.dbHost}`);

    const dumpCmd =
      `MYSQL_PWD='${site.dbPass.replace(/'/g, "'\\''")}' ` +
      `mysqldump -h${site.dbHost} -u${site.dbUser} ` +
      `--single-transaction --routines --triggers ${site.dbName} > ${tmpRemote}`;

    const dumpResult = await this.ssh.exec(dumpCmd);
    if (dumpResult.code !== 0) {
      throw new LocalWPError(
        `mysqldump failed: ${dumpResult.stderr}`,
        LocalWPErrorCode.DB_EXPORT_FAILED,
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
      throw new LocalWPError(
        `Invalid database name: ${site.dbName}`,
        LocalWPErrorCode.DB_IMPORT_FAILED,
        false
      );
    }

    const localSqlPath = path.join(localSitePath, '.localwp', 'db.sql');
    const tmpRemote = `/tmp/localwp_push_${site.dbName}_${Date.now()}.sql`;

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
      throw new LocalWPError(
        'No local database dump found. Pull the site first.',
        LocalWPErrorCode.DB_IMPORT_FAILED,
        false
      );
    }

    // Upload dump
    onProgress?.('Uploading database dump…');
    await this.sftp.fastPut(localSqlPath, tmpRemote);

    // Import on remote
    onProgress?.('Importing database on server…');
    logger.info(`[DatabaseSyncer] Importing ${site.dbName} on ${site.dbHost}`);

    const importCmd =
      `MYSQL_PWD='${site.dbPass.replace(/'/g, "'\\''")}' ` +
      `mysql -h${site.dbHost} -u${site.dbUser} ${site.dbName} < ${tmpRemote}`;

    const importResult = await this.ssh.exec(importCmd);

    // Cleanup remote temp file
    await this.ssh.exec(`rm -f ${tmpRemote}`).catch((err) => {
      logger.warn(`[DatabaseSyncer] Failed to cleanup temp file: ${err.message}`);
    });

    if (importResult.code !== 0) {
      throw new LocalWPError(
        `MySQL import failed: ${importResult.stderr}`,
        LocalWPErrorCode.DB_IMPORT_FAILED,
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
