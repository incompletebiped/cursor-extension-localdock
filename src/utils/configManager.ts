import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export class ConfigManager {
  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('localwpCpanel');
  }

  get localSitesDirectory(): string {
    const dir = this.config.get<string>('localSitesDirectory', '');
    return dir || path.join(os.homedir(), 'localwp-sites');
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
    return this.config.get<boolean>('rejectUnauthorizedSsl', false);
  }

  get sshPort(): number {
    return this.config.get<number>('sshPort', 22);
  }

  get excludePatterns(): string[] {
    return this.config.get<string[]>('excludePatterns', [
      'wp-content/uploads/**',   // media uploads — large, no need to sync
      'wp-content/cache/**',
      'wp-content/backup-db/**',
      '*.log',
      '.DS_Store',
      'node_modules/**',
    ]);
  }

  get databaseSyncMethod(): 'mysqldump' | 'wpcli' {
    return this.config.get<'mysqldump' | 'wpcli'>('databaseSyncMethod', 'mysqldump');
  }

  get maxConcurrentTransfers(): number {
    return this.config.get<number>('maxConcurrentTransfers', 5);
  }
}
