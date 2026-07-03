import * as vscode from 'vscode';
import { CpanelServer } from './models/Server';
import { WordPressSite } from './models/Site';
import { CredentialManager } from './auth/CredentialManager';

const SERVERS_KEY = 'localdock.servers';
const SITES_KEY_PREFIX = 'localdock.sites.';

export class SiteRegistry {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly credManager: CredentialManager
  ) {}

  // --- Servers ---

  getServers(): CpanelServer[] {
    return this.context.globalState.get<CpanelServer[]>(SERVERS_KEY, []);
  }

  getServer(id: string): CpanelServer | undefined {
    return this.getServers().find((s) => s.id === id);
  }

  async addServer(server: CpanelServer): Promise<void> {
    const servers = this.getServers();
    servers.push(server);
    await this.context.globalState.update(SERVERS_KEY, servers);
  }

  async removeServer(serverId: string): Promise<void> {
    const sites = this.getSites(serverId);
    await Promise.all(sites.map(s => this.credManager.deleteDbPassword(s.id)));
    await Promise.all(sites.map(s => this.credManager.deleteCompanionKey(s.id)));
    const servers = this.getServers().filter((s) => s.id !== serverId);
    await this.context.globalState.update(SERVERS_KEY, servers);
    await this.context.globalState.update(SITES_KEY_PREFIX + serverId, undefined);
  }

  async updateServer(server: CpanelServer): Promise<void> {
    const servers = this.getServers().map((s) =>
      s.id === server.id ? server : s
    );
    await this.context.globalState.update(SERVERS_KEY, servers);
  }

  // --- Sites ---

  getSites(serverId: string): WordPressSite[] {
    return this.context.globalState.get<WordPressSite[]>(
      SITES_KEY_PREFIX + serverId,
      []
    );
  }

  async setSites(serverId: string, sites: WordPressSite[]): Promise<void> {
    await Promise.all(
      sites.filter(s => s.dbPass).map(s => this.credManager.storeDbPassword(s.id, s.dbPass))
    );
    await this.context.globalState.update(
      SITES_KEY_PREFIX + serverId,
      sites.map(s => ({ ...s, dbPass: '' }))
    );
  }

  async updateSite(site: WordPressSite): Promise<void> {
    const sites = this.getSites(site.serverId).map((s) =>
      s.id === site.id ? site : s
    );
    await this.setSites(site.serverId, sites);
  }

  getAllSites(): WordPressSite[] {
    const servers = this.getServers();
    return servers.flatMap((s) => this.getSites(s.id));
  }
}
