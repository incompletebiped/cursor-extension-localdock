import * as vscode from 'vscode';
import { CpanelServer } from './models/Server';
import { WordPressSite } from './models/Site';

const SERVERS_KEY = 'localdock.servers';
const SITES_KEY_PREFIX = 'localdock.sites.';

export class SiteRegistry {
  constructor(private readonly context: vscode.ExtensionContext) {}

  // --- Servers ---

  getServers(): CpanelServer[] {
    return this.context.globalState.get<CpanelServer[]>(SERVERS_KEY, []);
  }

  async addServer(server: CpanelServer): Promise<void> {
    const servers = this.getServers();
    servers.push(server);
    await this.context.globalState.update(SERVERS_KEY, servers);
  }

  async removeServer(serverId: string): Promise<void> {
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
    await this.context.globalState.update(SITES_KEY_PREFIX + serverId, sites);
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
