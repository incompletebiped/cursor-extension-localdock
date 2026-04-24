import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { SiteRegistry } from '../SiteRegistry';
import { CredentialManager } from '../auth/CredentialManager';
import { ConfigManager } from '../utils/configManager';
import { CpanelClient } from '../api/CpanelClient';
import { SshClient } from '../api/SshClient';
import { SftpClient } from '../api/SftpClient';
import { SiteTreeItem, LoadingTreeItem, EmptyTreeItem } from './SiteTreeItem';

import { WordPressSite } from '../models/Site';
import { logger } from '../utils/logger';

type SiteNode = SiteTreeItem | LoadingTreeItem | EmptyTreeItem;

export class SiteTreeProvider implements vscode.TreeDataProvider<SiteNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SiteNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private loadingServers = new Set<string>();
  /** In-memory overlay for transient states (pushing progress). Never written to disk. */
  private transientStates = new Map<string, WordPressSite>();

  constructor(
    private readonly registry: SiteRegistry,
    private readonly credManager: CredentialManager,
    private readonly configManager: ConfigManager
  ) {}

  refresh(): void {
    // Re-discover sites on all servers
    const servers = this.registry.getServers();
    for (const server of servers) {
      void this.discoverSites(server.id);
    }
    this._onDidChangeTreeData.fire();
  }

  /** Called externally when a new server is added */
  discoverForServer(serverId: string): void {
    void this.discoverSites(serverId);
  }

  getTreeItem(element: SiteNode): vscode.TreeItem {
    return element;
  }

  getChildren(_element?: SiteNode): SiteNode[] {
    const servers = this.registry.getServers();

    if (servers.length === 0) {
      return [new EmptyTreeItem('Add a server to see WordPress sites.')];
    }

    const nodes: SiteNode[] = [];

    for (const server of servers) {
      if (this.loadingServers.has(server.id)) {
        nodes.push(new LoadingTreeItem());
        continue;
      }

      const sites = this.registry.getSites(server.id);

      if (sites.length === 0) {
        void this.discoverSites(server.id);
        nodes.push(new LoadingTreeItem());
      } else {
        // Sort alphabetically by domain, applying any in-memory transient state overlay
        const sorted = [...sites].sort((a, b) => a.domain.localeCompare(b.domain));
        nodes.push(...sorted.map((s) => new SiteTreeItem(this.transientStates.get(s.id) ?? s)));
      }
    }

    return nodes;
  }

  private async discoverSites(serverId: string): Promise<void> {
    if (this.loadingServers.has(serverId)) {
      return;
    }

    const server = this.registry.getServers().find((s) => s.id === serverId);
    if (!server) {
      return;
    }

    this.loadingServers.add(serverId);
    this._onDidChangeTreeData.fire();

    try {
      const creds = await this.credManager.get(serverId);
      if (!creds) {
        logger.warn(`[SiteTreeProvider] No credentials for server ${serverId}`);
        return;
      }

      const cpanel = new CpanelClient(server, creds, this.configManager.rejectUnauthorizedSsl);
      const domains = await cpanel.listDomains();
      logger.info(`[SiteTreeProvider] Checking ${domains.length} domains on ${server.host} via API`);

      // Try SSH for faster/richer detection; fall back to pure HTTPS API if SSH is unavailable
      let sshAvailable = false;
      const ssh = new SshClient();
      const sftp = new SftpClient();

      try {
        await ssh.connect(server, creds);
        await sftp.open(ssh);
        sshAvailable = true;
        logger.info(`[SiteTreeProvider] SSH available for ${server.host}, using SSH detection`);
      } catch (sshErr) {
        logger.info(
          `[SiteTreeProvider] SSH unavailable for ${server.host} (${(sshErr as Error).message}), using API-only detection`
        );
      }

      try {
        const sitePromises = domains.map(async (domain) => {
          let wp = null;

          if (sshAvailable) {
            wp = await cpanel.detectWordPress(sftp, ssh, domain).catch((err: Error) => {
              logger.warn(`[SiteTreeProvider] SSH detection failed for ${domain.domain}: ${err.message}`);
              return null;
            });
          }

          // Fall back to API detection if SSH didn't work
          if (!wp) {
            wp = await cpanel.detectWordPressViaApi(domain).catch((err: Error) => {
              logger.warn(`[SiteTreeProvider] API detection failed for ${domain.domain}: ${err.message}`);
              return null;
            });
          }

          if (!wp) { return null; }

          const existing = this.registry.getSites(serverId).find((s) => s.domain === domain.domain);

          // Validate that the previously-pulled folder still exists on disk.
          // If the user deleted it outside the extension, reset to not_pulled.
          let localPath = existing?.localPath;
          let syncState = existing?.syncState ?? { status: 'not_pulled' as const };
          let localEnv = existing?.localEnv;
          if (localPath) {
            try {
              await fs.access(localPath);
            } catch {
              localPath = undefined;
              syncState = { status: 'not_pulled' as const };
              localEnv = undefined;
            }
          }

          const site: WordPressSite = {
            id: `${serverId}::${domain.domain}`,
            serverId,
            domain: domain.domain,
            docroot: domain.docroot,
            wpVersion: wp.wpVersion,
            dbName: wp.dbName,
            dbUser: wp.dbUser,
            dbHost: wp.dbHost,
            dbPass: wp.dbPass,
            localPath,
            syncState,
            localEnv,
            detectedAt: new Date().toISOString(),
          };

          return site;
        });

        const results = await Promise.all(sitePromises);
        const sites = results.filter((s): s is WordPressSite => s !== null);

        await this.registry.setSites(serverId, sites);
        logger.info(`[SiteTreeProvider] Found ${sites.length} WP sites on ${server.host}`);
      } finally {
        if (ssh.isConnected) {
          sftp.close();
          await ssh.disconnect();
        }
      }
    } catch (err) {
      logger.error(
        `[SiteTreeProvider] Discovery failed for ${server.host}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.loadingServers.delete(serverId);
      this._onDidChangeTreeData.fire();
    }
  }

  /** Persist a meaningful state transition (pulling, pulled, pushing, error) and refresh the tree. */
  async updateSiteState(site: WordPressSite): Promise<void> {
    this.transientStates.delete(site.id); // clear any transient overlay
    await this.registry.updateSite(site);
    this._onDidChangeTreeData.fire();
  }

  /**
   * Update transient display state (progress during push/pull) without writing to disk.
   * Fire-and-forget safe — no concurrent registry write race.
   */
  setTransientState(site: WordPressSite): void {
    this.transientStates.set(site.id, site);
    this._onDidChangeTreeData.fire();
  }
}
