import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { LocalEnvItem, LocalDockerTreeProvider } from '../tree/LocalDockerTreeProvider';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { ActivityManager } from '../ActivityManager';
import { DockerManager } from '../docker/DockerManager';
import { SiteRegistry } from '../SiteRegistry';
import { readManifest, writeManifest } from '../sync/Manifest';
import { handleError } from '../utils/errors';
import { logger } from '../utils/logger';

const GENERATED_FILES = [
  { rel: '.localdock/docker-compose.yml', label: 'docker-compose.yml — rebuilt from latest template' },
  { rel: '.localdock/wp-config.docker.bak', label: 'wp-config.docker.bak — wp-config.php will be re-patched' },
  { rel: 'wp-content/uploads/.htaccess', label: 'uploads/.htaccess — uploads proxy will be re-written' },
  { rel: 'wp-content/mu-plugins/localdock-mail.php', label: 'localdock-mail.php — Mailpit plugin will be re-written' },
  { rel: 'wp-content/mu-plugins/localdock-dev-env.php', label: 'localdock-dev-env.php — dev environment plugin will be re-written' },
];

export async function resetLocalConfig(
  item: SiteTreeItem | LocalEnvItem,
  registry: SiteRegistry,
  siteTreeProvider: SiteTreeProvider,
  localDockerTreeProvider: LocalDockerTreeProvider,
  activityManager: ActivityManager,
  dockerManager: DockerManager
): Promise<void> {
  const site = item.site;

  if (!site.localPath) {
    vscode.window.showWarningMessage(`"${site.domain}" has not been pulled yet.`);
    return;
  }

  // Show what will be reset and ask for confirmation
  const confirmItems: vscode.QuickPickItem[] = [
    {
      label: `$(refresh) Reset config for ${site.domain}`,
      description: 'Confirm — site files and database are untouched',
      alwaysShow: true,
    },
    { label: 'Files that will be deleted and regenerated on next Start Local:', kind: vscode.QuickPickItemKind.Separator },
    ...GENERATED_FILES.map(f => ({ label: `$(trash) ${f.label}` })),
  ];

  const choice = await vscode.window.showQuickPick(confirmItems, {
    title: `Reset Local Config — ${site.domain}`,
    placeHolder: 'Select "Reset config" to confirm, or press Escape to cancel',
    canPickMany: false,
  });

  if (!choice?.label.includes('Reset config')) {
    return;
  }

  // Stop the environment if it's running
  if (site.localEnv?.status === 'running' || site.localEnv?.status === 'starting') {
    const { id: opId } = activityManager.start(site.domain, site.serverId, 'stop-local');
    try {
      activityManager.update(opId, 10, 'Stopping containers before reset…');
      await dockerManager.stop(site.localPath);
      activityManager.complete(opId);
    } catch (err) {
      activityManager.fail(opId, err instanceof Error ? err.message : String(err));
      handleError('resetLocalConfig/stop', err);
      return;
    }

    const stoppedSite = { ...site, localEnv: { status: 'stopped' as const } };
    await registry.updateSite(stoppedSite);
    siteTreeProvider.updateSiteState(stoppedSite);
    localDockerTreeProvider.refresh();
  }

  // Delete each generated file (ignore missing — already clean)
  for (const { rel } of GENERATED_FILES) {
    const fullPath = path.join(site.localPath, rel);
    try {
      await fs.unlink(fullPath);
      logger.info(`[resetLocalConfig] Deleted ${rel}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`[resetLocalConfig] Could not delete ${rel}: ${(err as Error).message}`);
      }
    }
  }

  // Reset the dbUrlRewritten flag so the DB is re-processed on next start
  const manifest = await readManifest(site.localPath);
  if (manifest) {
    await writeManifest(site.localPath, { ...manifest, dbUrlRewritten: false, localPort: manifest.localPort });
  }

  // Clear the localEnv state so the UI shows "not initialized"
  const resetSite = { ...site, localEnv: undefined };
  await registry.updateSite(resetSite);
  siteTreeProvider.updateSiteState(resetSite);
  localDockerTreeProvider.refresh();

  vscode.window.showInformationMessage(
    `Config reset for ${site.domain}. Run "Start Local" to rebuild with the latest settings.`
  );
  logger.info(`[resetLocalConfig] Config reset complete for ${site.domain}`);
}
