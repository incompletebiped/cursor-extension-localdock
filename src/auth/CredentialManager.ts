import * as vscode from 'vscode';
import { StoredCredentials, ResolvedCredentials } from '../models/Credentials';

const SECRET_KEY_PREFIX = 'localdock.creds.';
const LOCAL_MYSQL_PASSWORD_KEY = 'localdock.localMysqlPassword';
const DB_PASS_KEY_PREFIX = 'localdock.dbpass.';
const COMPANION_KEY_PREFIX = 'localdock.companionKey.';

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

  async storeDbPassword(siteId: string, dbPass: string): Promise<void> {
    await this.context.secrets.store(DB_PASS_KEY_PREFIX + siteId, dbPass);
  }

  async getDbPassword(siteId: string): Promise<string> {
    return (await this.context.secrets.get(DB_PASS_KEY_PREFIX + siteId)) ?? '';
  }

  async deleteDbPassword(siteId: string): Promise<void> {
    await this.context.secrets.delete(DB_PASS_KEY_PREFIX + siteId);
  }

  async storeCompanionKey(siteId: string, apiKey: string): Promise<void> {
    await this.context.secrets.store(COMPANION_KEY_PREFIX + siteId, apiKey);
  }

  async getCompanionKey(siteId: string): Promise<string | undefined> {
    return this.context.secrets.get(COMPANION_KEY_PREFIX + siteId);
  }

  async deleteCompanionKey(siteId: string): Promise<void> {
    await this.context.secrets.delete(COMPANION_KEY_PREFIX + siteId);
  }
}
