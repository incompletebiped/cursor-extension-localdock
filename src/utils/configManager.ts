import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export class ConfigManager {
  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('localdockCpanel');
  }

  get localSitesDirectory(): string {
    const dir = this.config.get<string>('localSitesDirectory', '');
    return dir || path.join(os.homedir(), 'localdock-sites');
  }

  get localMysqlHost(): string {
    return this.config.get<string>('localMysqlHost', '127.0.0.1');
  }

  get localMysqlPort(): number {
    return this.config.get<number>('localMysqlPort', 3306);
  }

  get localMysqlUser(): string {
    return this.config.get<string>('localMysqlUser', 'root');
  }

  get rejectUnauthorizedSsl(): boolean {
    return this.config.get<boolean>('rejectUnauthorizedSsl', true);
  }

  get sshPort(): number {
    return this.config.get<number>('sshPort', 22);
  }

  get excludePatterns(): string[] {
    return this.config.get<string[]>('excludePatterns', [
      'wp-content/uploads/**',
      'wp-content/cache/**',
      'wp-content/backup-db/**',
      '*.log',
      '.DS_Store',
      'node_modules/**',
      // Drop-ins that talk to production infrastructure (Redis, Memcached, custom DB)
      // and will silently break local option reads when those servers aren't in Docker.
      'wp-content/object-cache.php',
      'wp-content/db.php',
    ]);
  }

  get pullUploads(): boolean {
    return this.config.get<boolean>('pullUploads', false);
  }

  /**
   * Upload subdirectory globs that are always pulled even when pullUploads is false.
   * Paths are relative to wp-content/uploads/. Used for plugin-generated CSS/JS
   * (Spectra/UAG, Hummingbird, etc.) so they don't 404 locally.
   */
  get uploadsSyncPaths(): string[] {
    return this.config.get<string[]>('uploadsSyncPaths', [
      'uag-plugin/**',
      'hummingbird-assets/**',
      'elementor/css/**',
      'elementor/fonts/**',
      'astra/**',
      'oceanwp/**',
      'generatepress/**',
      'bb-plugin/**',
      'fusion-styles/**',
    ]);
  }

  /**
   * Patterns excluded from push diffs. Uploads are intentionally NOT excluded so
   * newly created local media gets pushed. The proxy .htaccess is excluded because
   * it is a local-only file that must never reach production.
   */
  get pushExcludePatterns(): string[] {
    return [
      // Config files patched for local Docker — must never reach production
      'wp-config.php',
      '.htaccess',
      // Generated / ephemeral
      'wp-content/cache/**',
      'wp-content/backup-db/**',
      '*.log',
      '.DS_Store',
      'node_modules/**',
      '.localdock/**',
      // Local-only files written by this extension
      'wp-content/uploads/.htaccess',
      'wp-content/mu-plugins/localdock-mail.php',
      'wp-content/mu-plugins/localdock-dev-env.php',
      'wp-content/object-cache.php',
      'wp-content/db.php',
      // Plugin-generated CSS caches — regenerate from DB on production, no need to push
      'wp-content/uploads/astra',
      'wp-content/uploads/uag-plugin',
      'wp-content/uploads/hummingbird-assets',
    ];
  }

  get databaseSyncMethod(): 'mysqldump' | 'wpcli' {
    return this.config.get<'mysqldump' | 'wpcli'>('databaseSyncMethod', 'mysqldump');
  }

  get maxConcurrentTransfers(): number {
    return this.config.get<number>('maxConcurrentTransfers', 5);
  }

  get dockerStartPort(): number {
    return this.config.get<number>('dockerStartPort', 8080);
  }
}
