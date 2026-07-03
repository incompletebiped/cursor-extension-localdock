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
import { handleError, LocalDockError, LocalDockErrorCode } from '../utils/errors';
import { logger } from '../utils/logger';
import { checkDriveEligibility } from '../utils/driveEligibility';
import { canStartLocalEnv } from '../utils/siteStatus';

export async function startLocal(
  item: SiteTreeItem | LocalEnvItem,
  registry: SiteRegistry,
  siteTreeProvider: SiteTreeProvider,
  localDockerTreeProvider: LocalDockerTreeProvider,
  activityManager: ActivityManager,
  dockerManager: DockerManager
): Promise<void> {
  const site = item.site;

  if (!canStartLocalEnv(site)) {
    const pullStatus = site.syncState.status;
    if (pullStatus === 'pulling' || pullStatus === 'pushing') {
      vscode.window.showWarningMessage(`Cannot start local environment while the site is ${pullStatus}.`);
    } else {
      vscode.window.showWarningMessage(`${site.domain} has not been pulled yet. Pull the site first.`);
    }
    return;
  }

  // canStartLocalEnv() guarantees localPath is set, but doesn't narrow it for TS.
  if (!site.localPath) {
    return;
  }

  // Preflight: Docker can only bind-mount fixed NTFS/ReFS drives. Catch an
  // unusable location up front with actionable guidance rather than letting
  // `docker compose up` fail with a cryptic "read-only file system" error.
  const eligibility = await checkDriveEligibility(site.localPath);
  if (!eligibility.eligible) {
    handleError(
      'startLocal',
      new LocalDockError(
        `${site.domain} is stored at ${site.localPath}, which Docker can't use. ${eligibility.reason ?? ''} ` +
          `Set a new Local Sites Folder and re-pull the site.`,
        LocalDockErrorCode.DRIVE_INELIGIBLE,
        false
      )
    );
    return;
  }

  const { id: opId } = activityManager.start(site.domain, site.serverId, 'start-local');

  // Update state to starting
  const startingSite = {
    ...site,
    localEnv: { status: 'starting' as const },
  };
  await registry.updateSite(startingSite);
  void siteTreeProvider.updateSiteState(startingSite);
  localDockerTreeProvider.refresh();

  try {
    // Ensure Docker is installed and the daemon is running; auto-launch if needed
    const version = await dockerManager.getDockerVersion();
    if (version === null) {
      throw new LocalDockError(
        'Docker Desktop is not installed or not in PATH. Download it from https://www.docker.com/products/docker-desktop',
        LocalDockErrorCode.DOCKER_NOT_FOUND,
        false
      );
    }

    if (!(await dockerManager.isDaemonRunning())) {
      activityManager.update(opId, 2, 'Launching Docker Desktop…');
      dockerManager.launchDockerDesktop();

      let started = false;
      for (let i = 0; i < 30; i++) {
        await new Promise<void>(r => setTimeout(r, 2000));
        if (await dockerManager.isDaemonRunning()) {
          started = true;
          break;
        }
        activityManager.update(opId, 3, `Waiting for Docker Desktop to start… (${(i + 1) * 2}s)`);
      }

      if (!started) {
        throw new LocalDockError(
          'Docker Desktop did not start in time. Please open it manually and try again.',
          LocalDockErrorCode.DOCKER_NOT_FOUND,
          true
        );
      }
    }

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

    // Ensure db.sql exists as a file before Docker mounts it. If the source path is
    // missing, Docker Desktop creates an empty directory instead; MySQL's init entrypoint
    // then fails on `mysql < db.sql` (can't redirect a directory) and crashes the container.
    const sqlPath = path.join(site.localPath, '.localdock', 'db.sql');
    try {
      await fs.access(sqlPath);
    } catch {
      await fs.writeFile(sqlPath, '', 'utf-8');
    }

    activityManager.update(opId, 20, 'Preparing database…');

    // Write the production URL so the mu-plugin can replace it with the local URL
    // on first WordPress boot using PHP's own serialization functions. This avoids
    // the byte-count corruption that raw SQL text replacement causes for serialized
    // values like astra-settings that contain single quotes (e.g. CSS url('...')).
    const productionUrl = `https://${site.domain}`;
    await fs.writeFile(
      path.join(site.localPath, '.localdock', 'production-url'),
      productionUrl,
      'utf-8'
    );

    // On first start, when a fresh compose was created, or when the port changed: wipe stale volumes and re-process db.sql
    const dbUrlRewritten = manifest?.dbUrlRewritten ?? false;
    const portChanged = manifest?.localPort !== undefined && manifest.localPort !== port;
    if (!dbUrlRewritten || composeWasCreated || portChanged) {
      activityManager.update(opId, 22, 'Clearing stale Docker volumes…');
      await dockerManager.reset(site.localPath);

      // reset() deleted the compose file — regenerate it from the latest template
      await dockerManager.scaffoldComposeFile(site.localPath, site.domain, port, 'wordpress');

      try {
        await fs.access(sqlPath);
        await DatabaseSyncer.stripDatabaseStatements(sqlPath);
        await DatabaseSyncer.appendSentinel(sqlPath);
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

    activityManager.update(opId, 45, 'Patching .htaccess for local HTTP…');
    await dockerManager.sanitizeRootHtaccess(site.localPath);

    activityManager.update(opId, 47, 'Configuring mail capture…');
    await dockerManager.scaffoldMailPlugin(site.localPath);

    activityManager.update(opId, 49, 'Configuring dev environment…');
    await dockerManager.scaffoldDevPlugin(site.localPath);

    // Remove any persistent object-cache drop-in pulled from production.
    // Production sites often use Redis/Memcached via object-cache.php.  In Docker
    // those servers don't exist, so the drop-in silently returns false for every
    // option read — including astra-settings — even though the data is in MySQL.
    const objectCachePath = path.join(site.localPath, 'wp-content', 'object-cache.php');
    await fs.unlink(objectCachePath).catch(() => {});

    activityManager.update(opId, 49, 'Clearing stale theme CSS cache…');
    await dockerManager.clearThemeCssCache(site.localPath);
    // Write trigger file so the dev mu-plugin clears transients on first WordPress boot
    await fs.writeFile(path.join(site.localPath, '.localdock', 'needs-init'), '', 'utf-8');

    activityManager.update(opId, 50, 'Starting Docker containers…');
    // docker compose up --wait blocks until all services are running/healthy
    await dockerManager.start(site.localPath);

    activityManager.update(opId, 95, 'Verifying containers…');
    const status = await dockerManager.getStatus(site.localPath);
    if (status !== 'running') {
      throw new Error(`Containers did not reach running state (status: ${status})`);
    }

    activityManager.complete(opId);

    // Update site with running state
    const runningSite = {
      ...site,
      localEnv: { status: 'running' as const, port, url: localUrl },
    };
    await registry.updateSite(runningSite);
    void siteTreeProvider.updateSiteState(runningSite);
    localDockerTreeProvider.refresh();

    // Auto-open in Cursor browser
    void vscode.commands.executeCommand('simpleBrowser.show', localUrl);

    void vscode.window.showInformationMessage(`${site.domain} running at ${localUrl}`);

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
    void siteTreeProvider.updateSiteState(errorSite);
    localDockerTreeProvider.refresh();

    handleError('startLocal', err);
  }
}

