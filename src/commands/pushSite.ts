import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { ActivityManager } from '../ActivityManager';
import { CredentialManager } from '../auth/CredentialManager';
import { ConfigManager } from '../utils/configManager';
import { SiteRegistry } from '../SiteRegistry';
import { SshClient } from '../api/SshClient';
import { SftpClient } from '../api/SftpClient';
import { FileSyncer } from '../sync/FileSyncer';
import { DatabaseSyncer } from '../sync/DatabaseSyncer';
import { readManifest, writeManifest } from '../sync/Manifest';
import { SiteManifest } from '../models/Manifest';
import { DiffEngine } from '../sync/DiffEngine';
import { DockerManager } from '../docker/DockerManager';
import { WordPressSite } from '../models/Site';
import { handleError } from '../utils/errors';
import { logger } from '../utils/logger';

export async function pushSite(
  item: SiteTreeItem,
  registry: SiteRegistry,
  credManager: CredentialManager,
  treeProvider: SiteTreeProvider,
  activityManager: ActivityManager,
  configManager: ConfigManager,
  dockerManager: DockerManager
): Promise<void> {
  const site = item.site;

  if (!site.localPath) {
    vscode.window.showWarningMessage(
      `"${site.domain}" has not been pulled. Pull it first.`
    );
    return;
  }

  const server = registry.getServers().find((s) => s.id === site.serverId);
  if (!server) {
    vscode.window.showErrorMessage(`Server not found for site "${site.domain}"`);
    return;
  }

  const creds = await credManager.get(site.serverId);
  if (!creds) {
    vscode.window.showErrorMessage(`No credentials found for server "${server.host}"`);
    return;
  }

  // Load manifest
  const manifest = await readManifest(site.localPath);
  if (!manifest) {
    vscode.window.showWarningMessage(
      `No manifest found for "${site.domain}". Pull the site first.`
    );
    return;
  }

  // Compute diff
  const engine = new DiffEngine();
  const diff = await engine.computeLocalChanges(
    site.localPath,
    manifest,
    configManager.pushExcludePatterns
  );

  const hasFileChanges = engine.hasChanges(diff);

  // Best-effort Docker status for display in confirmation dialog.
  // The actual export attempt is the authoritative check — getStatus can return
  // non-running on Windows even when containers are up (compose project lookup issues).
  const dockerStatus = site.localPath ? await dockerManager.getStatus(site.localPath) : 'stopped';
  const dockerLikelyRunning = dockerStatus === 'running';

  if (!hasFileChanges && !dockerLikelyRunning) {
    vscode.window.showInformationMessage(
      `"${site.domain}" has no local file changes and Docker is not running. Start the local environment to include database changes.`
    );
    return;
  }

  // Show confirmation with change summary
  const changeItems: vscode.QuickPickItem[] = [
    ...diff.added.map((f) => ({ label: `$(add) ${f}`, description: 'will be uploaded' })),
    ...diff.modified.map((f) => ({ label: `$(edit) ${f}`, description: 'will be updated' })),
    ...diff.deleted.map((f) => ({ label: `$(trash) ${f}`, description: 'will be deleted' })),
    { label: '$(database) database', description: dockerLikelyRunning ? 'will be exported from Docker and pushed' : 'will start db container, export, then stop it' },
  ];

  const fileSummary = hasFileChanges ? engine.formatSummary(diff) : 'database only';
  const confirm = await vscode.window.showQuickPick(
    [
      {
        label: `$(cloud-upload) Push ${fileSummary} to ${site.domain}`,
        description: 'Confirm push',
        alwaysShow: true,
      },
      ...changeItems,
    ],
    {
      title: `Push to ${site.domain}`,
      placeHolder: 'Review changes and select "Push" to confirm, or press Escape to cancel',
      canPickMany: false,
    }
  );

  if (!confirm || !confirm.label.includes('Push')) {
    return;
  }

  const { id: opId, token } = activityManager.start(site.domain, site.serverId, 'push');

  const updatedSite: WordPressSite = {
    ...site,
    syncState: { status: 'pushing', progress: 0 },
  };
  await treeProvider.updateSiteState(updatedSite);

  const ssh = new SshClient();
  const sftp = new SftpClient();

  const report = (progress: number, message: string) => {
    activityManager.update(opId, progress, message);
    // setTransientState is purely in-memory — no async disk write, no concurrent-write race
    treeProvider.setTransientState({
      ...updatedSite,
      syncState: { status: 'pushing', progress, message },
    });
  };

  try {
    await ssh.connect(server, creds);
    await sftp.open(ssh);

    if (token.isCancellationRequested) {
      activityManager.cancel(opId);
      await treeProvider.updateSiteState({ ...site, syncState: { status: 'pulled', lastPulledAt: site.syncState.lastPulledAt } });
      return;
    }

    const localMysqlPassword = await credManager.getLocalMysqlPassword();
    const dbSyncer = new DatabaseSyncer(ssh, sftp, {
      host: configManager.localMysqlHost,
      port: configManager.localMysqlPort,
      user: configManager.localMysqlUser,
      password: localMysqlPassword,
    });
    const fileSyncer = new FileSyncer(sftp, configManager.maxConcurrentTransfers);

    const progressAdapter = {
      report: ({ message }: { message?: string; increment?: number }) => {
        if (message) {
          const match = message.match(/\((\d+) \/ (\d+)\)/);
          const pct = match
            ? Math.round((parseInt(match[1], 10) / parseInt(match[2], 10)) * 70) + 10 // 10–80%
            : undefined;
          report(pct ?? activityManager.getRunning().find(o => o.id === opId)?.progress ?? 0, message);
        }
      },
    };

    let newFileIndex: SiteManifest['fileIndex'] = {};
    if (hasFileChanges) {
      report(5, 'Uploading changed files…');
      newFileIndex = await fileSyncer.uploadChanged(
        site.localPath!,
        site.docroot,
        [...diff.added, ...diff.modified],
        diff.deleted,
        token,
        progressAdapter
      );

      if (token.isCancellationRequested) {
        activityManager.cancel(opId);
        await treeProvider.updateSiteState({ ...site, syncState: { status: 'pulled', lastPulledAt: site.syncState.lastPulledAt } });
        return;
      }
    }

    // Export the database from Docker MySQL — start just the db service if containers
    // aren't running so the user doesn't have to manually start the environment first.
    let dbPushed = false;
    let dbFailError: string | null = null;
    let dbServiceStarted = false;
    let dockerDumpPath: string | null = null;
    try {
      report(82, 'Exporting database from Docker…');

      let sql: string;
      try {
        sql = await dockerManager.exportDatabase(site.localPath!);
      } catch (firstErr) {
        if (dockerLikelyRunning) {
          // Environment IS running — export failed for another reason, don't try to restart
          throw firstErr;
        }
        // Containers not running — start just the db service for the export
        report(82, 'Starting database container for export…');
        await dockerManager.startDbOnly(site.localPath!);
        dbServiceStarted = true;
        report(83, 'Exporting database from Docker…');
        sql = await dockerManager.exportDatabase(site.localPath!);
      }

      if (sql && sql.trim().length > 100) {
        dockerDumpPath = path.join(site.localPath!, '.localdock', 'db.push.tmp.sql');
        await fs.writeFile(dockerDumpPath, sql, 'utf-8');
        logger.info(`[pushSite] DB dump: ${sql.length} bytes`);

        report(84, 'Pushing database…');
        await dbSyncer.pushDatabase(site, site.localPath!, (msg) => report(85, msg), dockerDumpPath);

        const localUrl = manifest.localPort ? `http://localhost:${manifest.localPort}` : undefined;
        const productionUrl = `https://${site.domain}`;
        if (localUrl && localUrl !== productionUrl) {
          await dbSyncer.fixUrlsOnServer(site, localUrl, productionUrl, (msg) => report(87, msg));
        }
        dbPushed = true;
      } else {
        logger.warn('[pushSite] Docker mysqldump returned empty output — DB push skipped');
        dbFailError = 'mysqldump returned empty output';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[pushSite] Docker DB export failed — DB not pushed: ${msg}`);
      dbFailError = msg;
    } finally {
      if (dbServiceStarted) {
        await dockerManager.stopDbOnly(site.localPath!).catch(() => {});
      }
      if (dockerDumpPath) {
        await fs.unlink(dockerDumpPath).catch(() => {});
      }
    }

    // Clear production page cache so Hummingbird/WP Rocket don't serve stale HTML
    report(94, 'Clearing production cache…');
    await ssh.exec(`rm -rf "${site.docroot}/wp-content/cache" 2>/dev/null; true`).catch(err =>
      logger.warn(`[pushSite] Cache clear failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    );

    report(97, 'Updating manifest…');
    const updatedManifest = {
      ...manifest,
      fileIndex: Object.fromEntries(
        Object.entries({ ...manifest.fileIndex, ...newFileIndex })
          .filter(([k]) => !diff.deleted.includes(k))
      ),
    };
    await writeManifest(site.localPath!, updatedManifest);

    // Update state BEFORE completing activity to avoid a race where the activity
    // fires a tree refresh while the site still has progress: 97 in the registry.
    const finishedSite: WordPressSite = {
      ...site,
      syncState: {
        status: 'pulled',
        lastPulledAt: site.syncState.lastPulledAt,
        lastPushedAt: new Date().toISOString(),
      },
    };
    await treeProvider.updateSiteState(finishedSite);
    activityManager.complete(opId);

    const fileCount = engine.totalChanges(diff);
    if (dbPushed) {
      vscode.window.showInformationMessage(
        `Pushed ${site.domain} — ${fileCount} file(s) + database synced.`
      );
    } else {
      vscode.window.showInformationMessage(
        `Pushed ${site.domain} — ${fileCount} file(s) synced.`
      );
      vscode.window.showWarningMessage(
        `Database was not pushed for ${site.domain}: ${dbFailError ?? 'unknown error'}`,
        'Show Logs'
      ).then(choice => {
        if (choice === 'Show Logs') {
          vscode.commands.executeCommand('localdockCpanel.showOutput');
        }
      });
    }
    logger.info(`[pushSite] Push complete for ${site.domain}`);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    activityManager.fail(opId, message);
    await treeProvider.updateSiteState({
      ...site,
      syncState: {
        ...site.syncState,
        status: 'error',
        lastError: message,
      },
    });
    handleError('pushSite', err);
  } finally {
    sftp.close();
    await ssh.disconnect();
  }
}
