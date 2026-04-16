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
import { SiteTreeItem } from './tree/SiteTreeItem';
import { ServerTreeItem } from './tree/ServerTreeProvider';
import { addServer } from './commands/addServer';
import { editServer } from './commands/editServer';
import { testConnection } from './commands/testConnection';
import { removeServer } from './commands/removeServer';
import { refreshSites } from './commands/refreshSites';
import { pullSite } from './commands/pullSite';
import { pushSite } from './commands/pushSite';
import { diffSite } from './commands/diffSite';
import { openSiteFolder } from './commands/openSiteFolder';

export function activate(context: vscode.ExtensionContext): void {
  logger.initialize(context);
  logger.info('LocalWP for cPanel activating…');

  const configManager = new ConfigManager();
  const credManager = new CredentialManager(context);
  const authProvider = new AuthProvider();
  const registry = new SiteRegistry(context);
  const activityManager = new ActivityManager();

  const serverTreeProvider = new ServerTreeProvider(registry);
  const siteTreeProvider = new SiteTreeProvider(registry, credManager, configManager);
  const activityTreeProvider = new ActivityTreeProvider(activityManager);

  // Reset any stale pulling/pushing states left from a previous session
  for (const site of registry.getAllSites()) {
    const s = site.syncState.status;
    if (s === 'pulling' || s === 'pushing') {
      siteTreeProvider.updateSiteState({
        ...site,
        syncState: { status: 'not_pulled' },
      }).catch(() => {});
    }
  }

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('localwpCpanel.serverTree', serverTreeProvider),
    vscode.window.registerTreeDataProvider('localwpCpanel.siteTree', siteTreeProvider),
    vscode.window.registerTreeDataProvider('localwpCpanel.activityTree', activityTreeProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('localwpCpanel.addServer', () =>
      addServer(registry, credManager, authProvider, serverTreeProvider, siteTreeProvider, configManager)
    ),

    vscode.commands.registerCommand('localwpCpanel.testConnection', (item: ServerTreeItem) =>
      testConnection(item, credManager, authProvider, siteTreeProvider)
    ),

    vscode.commands.registerCommand('localwpCpanel.editServer', (item: ServerTreeItem) =>
      editServer(item, registry, credManager, serverTreeProvider, siteTreeProvider)
    ),

    vscode.commands.registerCommand('localwpCpanel.removeServer', (item: ServerTreeItem) =>
      removeServer(item, registry, credManager, serverTreeProvider, siteTreeProvider)
    ),

    vscode.commands.registerCommand('localwpCpanel.refreshSites', () =>
      refreshSites(siteTreeProvider)
    ),

    vscode.commands.registerCommand('localwpCpanel.pullSite', (item: SiteTreeItem) =>
      pullSite(item, registry, credManager, siteTreeProvider, activityManager, configManager)
    ),

    vscode.commands.registerCommand('localwpCpanel.pushSite', (item: SiteTreeItem) =>
      pushSite(item, registry, credManager, siteTreeProvider, activityManager, configManager)
    ),

    vscode.commands.registerCommand('localwpCpanel.diffSite', (item: SiteTreeItem) =>
      diffSite(item, siteTreeProvider, configManager)
    ),

    vscode.commands.registerCommand('localwpCpanel.openSiteFolder', (item: SiteTreeItem) =>
      openSiteFolder(item)
    ),

    vscode.commands.registerCommand('localwpCpanel.cancelOperation', (item) => {
      const opId = activityTreeProvider.getOperationId(item);
      if (opId) {
        activityManager.cancel(opId);
      }
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

  logger.info('LocalWP for cPanel activated.');
}

export function deactivate(): void {
  logger.info('LocalWP for cPanel deactivated.');
}
