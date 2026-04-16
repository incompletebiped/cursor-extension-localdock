import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { LocalEnvItem, LocalDockerTreeProvider } from '../tree/LocalDockerTreeProvider';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { ActivityManager } from '../ActivityManager';
import { DockerManager } from '../docker/DockerManager';
import { DatabaseSyncer } from '../sync/DatabaseSyncer';
import { SiteRegistry } from '../SiteRegistry';
import { readManifest, writeManifest } from '../sync/Manifest';
import { handleError } from '../utils/errors';
import { logger } from '../utils/logger';

export async function startLocal(
  item: SiteTreeItem | LocalEnvItem,
  registry: SiteRegistry,
  siteTreeProvider: SiteTreeProvider,
  localDockerTreeProvider: LocalDockerTreeProvider,
  activityManager: ActivityManager,
  dockerManager: DockerManager
): Promise<void> {
  const site = item.site;

  if (!site.localPath) {
    vscode.window.showWarningMessage(`${site.domain} has not been pulled yet. Pull the site first.`);
    return;
  }

  const pullStatus = site.syncState.status;
  if (pullStatus === 'not_pulled' || pullStatus === 'pulling' || pullStatus === 'pushing') {
    vscode.window.showWarningMessage(`Cannot start local environment while the site is ${pullStatus}.`);
    return;
  }

  // Check Docker is available
  try {
    await dockerManager.assertDockerAvailable();
  } catch (err) {
    handleError('startLocal', err);
    return;
  }

  const { id: opId } = activityManager.start(site.domain, site.serverId, 'start-local');

  // Update state to starting
  const startingSite = {
    ...site,
    localEnv: { status: 'starting' as const },
  };
  await registry.updateSite(startingSite);
  siteTreeProvider.updateSiteState(startingSite);
  localDockerTreeProvider.refresh();

  try {
    // Read manifest
    const manifest = await readManifest(site.localPath);

    // Assign port
    const port = await dockerManager.assignPort(site.localPath, manifest);
    const localUrl = `http://localhost:${port}`;

    // Persist port to manifest
    if (manifest) {
      await writeManifest(site.localPath, { ...manifest, localPort: port });
    }

    activityManager.update(opId, 10, 'Scaffolding docker-compose.yml…');

    // Scaffold compose file
    const { wasCreated: composeWasCreated } = await dockerManager.scaffoldComposeFile(site.localPath, site.domain, port, 'wordpress');

    activityManager.update(opId, 20, 'Rewriting database URLs…');

    // On first start OR when a fresh compose was just created: wipe stale volumes and re-process db.sql
    const sqlPath = path.join(site.localPath, '.localdock', 'db.sql');
    const dbUrlRewritten = manifest?.dbUrlRewritten ?? false;
    if (!dbUrlRewritten || composeWasCreated) {
      activityManager.update(opId, 22, 'Clearing stale Docker volumes…');
      await dockerManager.reset(site.localPath);

      try {
        await fs.access(sqlPath);
        const productionUrl = `https://${site.domain}`;
        await DatabaseSyncer.rewriteUrlsInDump(sqlPath, productionUrl, localUrl);
        await DatabaseSyncer.stripDatabaseStatements(sqlPath);
        const updatedManifest = await readManifest(site.localPath);
        if (updatedManifest) {
          await writeManifest(site.localPath, { ...updatedManifest, localPort: port, dbUrlRewritten: true });
        }
      } catch (err) {
        logger.warn(`[startLocal] Could not process db.sql: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    activityManager.update(opId, 35, 'Patching wp-config.php…');
    await dockerManager.patchWpConfig(site.localPath, localUrl);

    activityManager.update(opId, 40, 'Configuring uploads proxy…');
    await dockerManager.scaffoldUploadsProxy(site.localPath, site.domain);

    activityManager.update(opId, 50, 'Starting Docker containers…');
    await dockerManager.start(site.localPath);

    // Poll for running status
    activityManager.update(opId, 60, 'Waiting for containers to be ready…');
    const maxAttempts = 30;
    let attempts = 0;
    let status = await dockerManager.getStatus(site.localPath);

    while (status !== 'running' && attempts < maxAttempts) {
      await delay(2000);
      status = await dockerManager.getStatus(site.localPath);
      attempts++;
      const progress = 60 + Math.floor((attempts / maxAttempts) * 35);
      activityManager.update(opId, progress, `Waiting for containers… (${attempts * 2}s)`);
    }

    if (status !== 'running') {
      throw new Error('Containers did not reach running state within 60 seconds');
    }

    activityManager.complete(opId);

    // Update site with running state
    const runningSite = {
      ...site,
      localEnv: { status: 'running' as const, port, url: localUrl },
    };
    await registry.updateSite(runningSite);
    siteTreeProvider.updateSiteState(runningSite);
    localDockerTreeProvider.refresh();

    // Notify user
    const choice = await vscode.window.showInformationMessage(
      `Local environment for ${site.domain} is running at ${localUrl}`,
      'Open in Browser'
    );
    if (choice === 'Open in Browser') {
      vscode.commands.executeCommand('localdockCpanel.openLocalSite', { site: runningSite });
    }

  } catch (err) {
    activityManager.fail(opId, err instanceof Error ? err.message : String(err));

    const errorSite = {
      ...site,
      localEnv: {
        status: 'error' as const,
        lastError: err instanceof Error ? err.message : String(err),
      },
    };
    await registry.updateSite(errorSite);
    siteTreeProvider.updateSiteState(errorSite);
    localDockerTreeProvider.refresh();

    handleError('startLocal', err);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
