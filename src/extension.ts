import * as vscode from 'vscode';
import * as fs from 'fs/promises';
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
import { checkRemoteDiff } from './commands/checkRemoteDiff';
import { openSiteFolder } from './commands/openSiteFolder';
import { startLocal } from './commands/startLocal';
import { stopLocal } from './commands/stopLocal';
import { openLocalSite } from './commands/openLocalSite';
import { resetLocalConfig } from './commands/resetLocalConfig';

let _registry: SiteRegistry | undefined;
let _dockerManager: DockerManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logger.initialize(context);
  logger.info('LocalDock for cPanel activating…');

  const configManager = new ConfigManager();
  const credManager = new CredentialManager(context);
  const authProvider = new AuthProvider();
  const registry = new SiteRegistry(context);
  const activityManager = new ActivityManager();
  const dockerManager = new DockerManager(configManager);

  _registry = registry;
  _dockerManager = dockerManager;

  const serverTreeProvider = new ServerTreeProvider(registry);
  const siteTreeProvider = new SiteTreeProvider(registry, credManager, configManager);
  const activityTreeProvider = new ActivityTreeProvider(activityManager);
  const localDockerTreeProvider = new LocalDockerTreeProvider(dockerManager, registry);

  // Reset stale states and validate local paths on startup
  await Promise.all(registry.getAllSites().map(async (site) => {
    const s = site.syncState.status;

    // If files were deleted outside the extension, reset to not_pulled
    if (site.localPath && (s === 'pulled' || s === 'modified' || s === 'error' || s === 'pulling' || s === 'pushing')) {
      let pathExists = false;
      try { await fs.access(site.localPath); pathExists = true; } catch { /* deleted */ }
      if (!pathExists) {
        await registry.updateSite({
          ...site,
          localPath: undefined,
          localEnv: undefined,
          syncState: { status: 'not_pulled' },
        });
        return;
      }
    }

    // Reconcile Docker running state against actual container status
    if (site.localEnv?.status === 'running' && site.localPath) {
      const actual = await dockerManager.getStatus(site.localPath).catch(() => 'stopped' as const);
      if (actual !== 'running') {
        await registry.updateSite({ ...site, localEnv: { status: 'stopped' } });
      }
    }

    // Reset in-progress states that were interrupted
    if (s === 'pulling' || s === 'pushing') {
      await siteTreeProvider.updateSiteState({
        ...site,
        syncState: { status: 'not_pulled' },
      });
    }
    const ls = site.localEnv?.status;
    if (ls === 'starting' || ls === 'stopping') {
      await registry.updateSite({
        ...site,
        localEnv: { ...site.localEnv, status: 'stopped' },
      });
    }
  }));


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

    vscode.commands.registerCommand('localdockCpanel.checkRemoteDiff', (item: SiteTreeItem) =>
      checkRemoteDiff(item, registry, credManager, activityManager, configManager)
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

    vscode.commands.registerCommand('localdockCpanel.resetLocalConfig', (item: SiteTreeItem | LocalEnvItem) =>
      resetLocalConfig(item, registry, siteTreeProvider, localDockerTreeProvider, activityManager, dockerManager)
    ),

    vscode.commands.registerCommand('localdockCpanel.openMailpit', (item: SiteTreeItem | LocalEnvItem) => {
      const site = 'site' in item ? (item as SiteTreeItem).site : (item as LocalEnvItem).site;
      if (!site.localEnv?.port || site.localEnv.status !== 'running') {
        vscode.window.showWarningMessage(`Local environment for ${site.domain} is not running.`);
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${site.localEnv.port + 1}`));
    }),

    vscode.commands.registerCommand('localdockCpanel.openAdminer', (item: SiteTreeItem | LocalEnvItem) => {
      const site = 'site' in item ? (item as SiteTreeItem).site : (item as LocalEnvItem).site;
      if (!site.localEnv?.port || site.localEnv.status !== 'running') {
        vscode.window.showWarningMessage(`Local environment for ${site.domain} is not running.`);
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${site.localEnv.port + 2}/?server=db&username=wordpress&db=wordpress`));
    }),

    vscode.commands.registerCommand('localdockCpanel.openDockerSetup', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://www.docker.com/products/docker-desktop'));
    }),

    vscode.commands.registerCommand('localdockCpanel.launchDockerDesktop', () => {
      dockerManager.launchDockerDesktop();
      vscode.window.showInformationMessage('Launching Docker Desktop…');
      localDockerTreeProvider.refresh();
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

export async function deactivate(): Promise<void> {
  logger.info('LocalDock for cPanel deactivating.');
  if (_registry && _dockerManager) {
    const running = _registry.getAllSites().filter(
      (s) => s.localEnv?.status === 'running' && s.localPath
    );
    await Promise.allSettled(running.map((s) => _dockerManager!.stop(s.localPath!)));
  }
}
