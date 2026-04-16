import * as vscode from 'vscode';
import { StoredCredentials, ResolvedCredentials } from '../models/Credentials';

const SECRET_KEY_PREFIX = 'localwp.creds.';
const LOCAL_MYSQL_PASSWORD_KEY = 'localwp.localMysqlPassword';

export class CredentialManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async store(serverId: string, creds: StoredCredentials): Promise<void> {
    await this.context.secrets.store(
      SECRET_KEY_PREFIX + serverId,
      JSON.stringify(creds)
    );
  }

  async get(serverId: string): Promise<ResolvedCredentials | undefined> {
    const raw = await this.context.secrets.get(SECRET_KEY_PREFIX + serverId);
    if (!raw) {
      return undefined;
    }
    const creds = JSON.parse(raw) as StoredCredentials;
    return { ...creds, serverId };
  }

  async delete(serverId: string): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY_PREFIX + serverId);
  }

  async storeLocalMysqlPassword(password: string): Promise<void> {
    await this.context.secrets.store(LOCAL_MYSQL_PASSWORD_KEY, password);
  }

  async getLocalMysqlPassword(): Promise<string | undefined> {
    return this.context.secrets.get(LOCAL_MYSQL_PASSWORD_KEY);
  }
}
