import * as vscode from 'vscode';
import { logger } from './utils/logger';
import { ConfigManager } from './utils/configManager';
import { CredentialManager } from './auth/CredentialManager';
import { AuthProvider } from './auth/AuthProvider';
import { SiteRegistry } from './SiteRegistry';
import { ActivityManager } from './ActivityManager';
import { ServerTreeProvider } from './tree/ServerTreeProvider';
import { SiteTreeProvider } from './tree/SiteTreeProvider';
import { ActivityTreeProvider } from './tree/ActivityTreeProvider';
import { LocalDockerTreeProvider } from './tree/LocalDockerTreeProvider';
import { SiteTreeItem } from './tree/SiteTreeItem';
import { LocalEnvItem } from './tree/LocalDockerTreeProvider';
import { ServerTreeItem } from './tree/ServerTreeProvider';
import { DockerManager } from './docker/DockerManager';
import { addServer } from './commands/addServer';
import { editServer } from './commands/editServer';
import { testConnection } from './commands/testConnection';
import { removeServer } from './commands/removeServer';
import { refreshSites } from './commands/refreshSites';
import { pullSite } from './commands/pullSite';
import { pushSite } from './commands/pushSite';
import { diffSite } from './commands/diffSite';
import { openSiteFolder } from './commands/openSiteFolder';
import { startLocal } from './commands/startLocal';
import { stopLocal } from './commands/stopLocal';
import { openLocalSite } from './commands/openLocalSite';

export function activate(context: vscode.ExtensionContext): void {
  logger.initialize(context);
  logger.info('LocalDock for cPanel activating…');

  const configManager = new ConfigManager();
  const credManager = new CredentialManager(context);
  const authProvider = new AuthProvider();
  const registry = new SiteRegistry(context);
  const activityManager = new ActivityManager();
  const dockerManager = new DockerManager(configManager);

  const serverTreeProvider = new ServerTreeProvider(registry);
  const siteTreeProvider = new SiteTreeProvider(registry, credManager, configManager);
  const activityTreeProvider = new ActivityTreeProvider(activityManager);
  const localDockerTreeProvider = new LocalDockerTreeProvider(dockerManager, registry, configManager);

  // Reset any stale pulling/pushing/starting/stopping states from previous session
  for (const site of registry.getAllSites()) {
    const s = site.syncState.status;
    if (s === 'pulling' || s === 'pushing') {
      siteTreeProvider.updateSiteState({
        ...site,
        syncState: { status: 'not_pulled' },
      }).catch(() => {});
    }
    const ls = site.localEnv?.status;
    if (ls === 'starting' || ls === 'stopping') {
      registry.updateSite({
        ...site,
        localEnv: { ...site.localEnv, status: 'stopped' },
      }).catch(() => {});
    }
  }

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('localdockCpanel.serverTree', serverTreeProvider),
    vscode.window.registerTreeDataProvider('localdockCpanel.siteTree', siteTreeProvider),
    vscode.window.registerTreeDataProvider('localdockCpanel.activityTree', activityTreeProvider),
    vscode.window.registerTreeDataProvider('localdockCpanel.localDockerTree', localDockerTreeProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('localdockCpanel.addServer', () =>
      addServer(registry, credManager, authProvider, serverTreeProvider, siteTreeProvider, configManager)
    ),

    vscode.commands.registerCommand('localdockCpanel.testConnection', (item: ServerTreeItem) =>
      testConnection(item, credManager, authProvider, siteTreeProvider)
    ),

    vscode.commands.registerCommand('localdockCpanel.editServer', (item: ServerTreeItem) =>
      editServer(item, registry, credManager, serverTreeProvider, siteTreeProvider)
    ),

    vscode.commands.registerCommand('localdockCpanel.removeServer', (item: ServerTreeItem) =>
      removeServer(item, registry, credManager, serverTreeProvider, siteTreeProvider)
    ),

    vscode.commands.registerCommand('localdockCpanel.refreshSites', () =>
      refreshSites(siteTreeProvider)
    ),

    vscode.commands.registerCommand('localdockCpanel.pullSite', (item: SiteTreeItem) =>
      pullSite(item, registry, credManager, siteTreeProvider, localDockerTreeProvider, activityManager, configManager)
    ),

    vscode.commands.registerCommand('localdockCpanel.pushSite', (item: SiteTreeItem) =>
      pushSite(item, registry, credManager, siteTreeProvider, activityManager, configManager)
    ),

    vscode.commands.registerCommand('localdockCpanel.diffSite', (item: SiteTreeItem) =>
      diffSite(item, siteTreeProvider, configManager)
    ),

    vscode.commands.registerCommand('localdockCpanel.openSiteFolder', (item: SiteTreeItem) =>
      openSiteFolder(item)
    ),

    vscode.commands.registerCommand('localdockCpanel.cancelOperation', (item) => {
      const opId = activityTreeProvider.getOperationId(item);
      if (opId) {
        activityManager.cancel(opId);
      }
    }),

    vscode.commands.registerCommand('localdockCpanel.startLocal', (item: SiteTreeItem | LocalEnvItem) =>
      startLocal(item, registry, siteTreeProvider, localDockerTreeProvider, activityManager, dockerManager)
    ),

    vscode.commands.registerCommand('localdockCpanel.stopLocal', (item: SiteTreeItem | LocalEnvItem) =>
      stopLocal(item, registry, siteTreeProvider, localDockerTreeProvider, activityManager, dockerManager)
    ),

    vscode.commands.registerCommand('localdockCpanel.openLocalSite', (item: SiteTreeItem | LocalEnvItem | { site: import('./models/Site').WordPressSite }) => {
      const site = 'site' in item ? item.site : (item as SiteTreeItem).site;
      return openLocalSite(site);
    }),

    vscode.commands.registerCommand('localdockCpanel.openDockerSetup', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://www.docker.com/products/docker-desktop'));
    })
  );

  // Cancel all running operations when the extension deactivates
  context.subscriptions.push({
    dispose: () => activityManager.cancelAll(),
  });

  // Kick off site discovery for all already-saved servers on activation
  for (const server of registry.getServers()) {
    siteTreeProvider.discoverForServer(server.id);
  }

  logger.info('LocalDock for cPanel activated.');
}

export function deactivate(): void {
  logger.info('LocalDock for cPanel deactivated.');
}
