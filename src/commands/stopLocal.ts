import * as vscode from 'vscode';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { LocalEnvItem, LocalDockerTreeProvider } from '../tree/LocalDockerTreeProvider';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { ActivityManager } from '../ActivityManager';
import { DockerManager } from '../docker/DockerManager';
import { SiteRegistry } from '../SiteRegistry';
import { handleError } from '../utils/errors';

export async function stopLocal(
  item: SiteTreeItem | LocalEnvItem,
  registry: SiteRegistry,
  siteTreeProvider: SiteTreeProvider,
  localDockerTreeProvider: LocalDockerTreeProvider,
  activityManager: ActivityManager,
  dockerManager: DockerManager
): Promise<void> {
  const site = item.site;

  if (!site.localPath) {
    return;
  }

  if (site.localEnv?.status !== 'running') {
    vscode.window.showWarningMessage(`${site.domain} local environment is not running.`);
    return;
  }

  const { id: opId } = activityManager.start(site.domain, site.serverId, 'stop-local');

  const stoppingSite = {
    ...site,
    localEnv: { ...site.localEnv, status: 'stopping' as const },
  };
  await registry.updateSite(stoppingSite);
  void siteTreeProvider.updateSiteState(stoppingSite);
  localDockerTreeProvider.refresh();

  try {
    activityManager.update(opId, 50, 'Stopping Docker containers…');
    await dockerManager.stop(site.localPath);
    activityManager.complete(opId);

    const stoppedSite = {
      ...site,
      localEnv: { status: 'stopped' as const, port: site.localEnv.port },
    };
    await registry.updateSite(stoppedSite);
    void siteTreeProvider.updateSiteState(stoppedSite);
    localDockerTreeProvider.refresh();

  } catch (err) {
    activityManager.fail(opId, err instanceof Error ? err.message : String(err));

    const errorSite = {
      ...site,
      localEnv: {
        status: 'error' as const,
        port: site.localEnv.port,
        lastError: err instanceof Error ? err.message : String(err),
      },
    };
    await registry.updateSite(errorSite);
    void siteTreeProvider.updateSiteState(errorSite);
    localDockerTreeProvider.refresh();

    handleError('stopLocal', err);
  }
}
