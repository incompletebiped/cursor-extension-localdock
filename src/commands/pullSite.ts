import * as vscode from 'vscode';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { LocalDockerTreeProvider } from '../tree/LocalDockerTreeProvider';
import { ActivityManager } from '../ActivityManager';
import { CredentialManager } from '../auth/CredentialManager';
import { ConfigManager } from '../utils/configManager';
import { SiteRegistry } from '../SiteRegistry';
import { SshClient } from '../api/SshClient';
import { connectPinned } from '../api/sshConnect';
import { SftpClient } from '../api/SftpClient';
import { FileSyncer } from '../sync/FileSyncer';
import { DatabaseSyncer } from '../sync/DatabaseSyncer';
import { readManifest, writeManifest } from '../sync/Manifest';
import { DiffEngine } from '../sync/DiffEngine';
import { planPull, PullConflict } from '../sync/PullPlanner';
import { planDatabasePush } from '../sync/ChangelogPushPlanner';
import { mergeDatabasePullPlan, fetchRemoteDatabaseRows, applyDatabasePullSql, DbPullConflict } from '../sync/ChangelogPullPlanner';
import { DockerManager } from '../docker/DockerManager';
import { WordPressSite } from '../models/Site';
import { SiteManifest } from '../models/Manifest';
import { sanitizeDbName } from '../utils/pathUtils';
import { handleError } from '../utils/errors';
import { logger } from '../utils/logger';
import { resolveLocalSitePath } from '../utils/locations';
import { checkDriveEligibility, isTrustCandidate, trustRemovableDrive } from '../utils/driveEligibility';
import { makeProgressAdapter } from '../utils/progressUtils';

const PULL_PROGRESS = { FILES_START: 10, FILES_END: 90, DB: 92, MANIFEST: 98 } as const;

export async function pullSite(
  item: SiteTreeItem,
  registry: SiteRegistry,
  credManager: CredentialManager,
  siteTreeProvider: SiteTreeProvider,
  localDockerTreeProvider: LocalDockerTreeProvider,
  activityManager: ActivityManager,
  configManager: ConfigManager,
  dockerManager: DockerManager
): Promise<void> {
  const site = item.site;
  const server = registry.getServer(site.serverId);
  if (!server) {
    vscode.window.showErrorMessage(`Server not found for "${site.domain}"`);
    return;
  }

  const creds = await credManager.get(site.serverId);
  if (!creds) {
    vscode.window.showErrorMessage(`No credentials for server "${server.host}"`);
    return;
  }

  // Resolve where to pull. A previously-stored localPath on an unusable drive
  // (e.g. the site was first pulled onto a removable/exFAT drive) must not be
  // reused — fall back to the configured base directory instead.
  let localPath = site.localPath ?? resolveLocalSitePath(site.domain);
  if (!(await checkDriveEligibility(localPath)).eligible) {
    localPath = resolveLocalSitePath(site.domain);
  }

  // Preflight: refuse to download onto a drive Docker can't bind-mount, instead
  // of wasting a multi-minute transfer that "Start Local" would later reject.
  let eligibility = await checkDriveEligibility(localPath);
  if (!eligibility.eligible && isTrustCandidate(eligibility) && eligibility.driveLetter) {
    const choice = await vscode.window.showErrorMessage(
      `Can't pull ${site.domain} to ${localPath}. ${eligibility.reason ?? ''}`,
      'Trust This Drive',
      'Choose Folder…'
    );
    if (choice === 'Trust This Drive') {
      await trustRemovableDrive(eligibility.driveLetter);
      eligibility = await checkDriveEligibility(localPath);
    } else if (choice === 'Choose Folder…') {
      await vscode.commands.executeCommand('localdockCpanel.setSitesDirectory');
      return;
    } else {
      return;
    }
  }
  if (!eligibility.eligible) {
    const choice = await vscode.window.showErrorMessage(
      `Can't pull ${site.domain} to ${localPath}. ${eligibility.reason ?? ''}`,
      'Choose Folder…'
    );
    if (choice === 'Choose Folder…') {
      await vscode.commands.executeCommand('localdockCpanel.setSitesDirectory');
    }
    return;
  }

  // A manifest already existing means this is a re-pull, not a first pull —
  // that's the baseline a smart, git-like merge diffs both sides against.
  const priorManifest = await readManifest(localPath);

  const { id: opId, token } = activityManager.start(site.domain, site.serverId, 'pull');

  const updatedSite: WordPressSite = {
    ...site, localPath,
    syncState: { status: 'pulling', progress: 0 },
  };
  await siteTreeProvider.updateSiteState(updatedSite);

  const ssh = new SshClient();
  const sftp = new SftpClient();

  const report = (progress: number, message: string) => {
    activityManager.update(opId, progress, message);
    siteTreeProvider.setTransientState({
      ...updatedSite,
      syncState: { status: 'pulling', progress, message },
    });
  };

  try {
    await connectPinned(ssh, server, creds, registry);
    await sftp.open(ssh);

    if (token.isCancellationRequested) {
      activityManager.cancel(opId);
      return;
    }

    const localMysqlPassword = await credManager.getLocalMysqlPassword();
    const siteDbPass = await credManager.getDbPassword(site.id);
    const dbSyncer = new DatabaseSyncer(ssh, sftp, {
      host: configManager.localMysqlHost,
      port: configManager.localMysqlPort,
      user: configManager.localMysqlUser,
      password: localMysqlPassword,
    });
    const fileSyncer = new FileSyncer(sftp, configManager.maxConcurrentTransfers);

    const progressAdapter = makeProgressAdapter(report, PULL_PROGRESS.FILES_START, PULL_PROGRESS.FILES_END);

    // When uploads are excluded, still pull plugin-generated subdirectories
    // (UAG/Spectra CSS, Hummingbird bundles, etc.) so they load without needing
    // the uploads proxy. Uses negation patterns (!path) to override the broad exclude.
    let pullExclude: string[];
    if (configManager.pullUploads) {
      pullExclude = configManager.excludePatterns.filter(p => p !== 'wp-content/uploads/**');
    } else {
      const negations = configManager.uploadsSyncPaths.map(
        p => `!wp-content/uploads/${p}`
      );
      pullExclude = [...configManager.excludePatterns, ...negations];
    }

    let fileIndex: SiteManifest['fileIndex'];
    let totalFiles: number;
    let failedFiles: string[];
    let filesRemovedLocally: string[] = [];
    let conflicts: PullConflict[] = [];

    if (!priorManifest) {
      // First pull for this site — no baseline to diff against, so there's
      // nothing "local" to protect yet. Full mirror, same as always.
      report(5, 'Indexing remote files…');
      const result = await fileSyncer.downloadAll(site.docroot, localPath, pullExclude, token, progressAdapter);
      fileIndex = result.fileIndex;
      totalFiles = result.totalFiles;
      failedFiles = result.failedFiles;
    } else {
      // Re-pull: diff what changed on the server against the same baseline
      // as what changed locally, and only touch paths the server actually
      // changed. A path the server didn't touch is never downloaded/deleted
      // here regardless of local state — that's what stops a locally-removed
      // theme/plugin folder from silently reappearing, and what leaves a
      // locally-edited page/file alone. A path changed on both sides is
      // surfaced as a conflict instead of being silently overwritten either way.
      report(5, 'Indexing remote files…');
      const remoteListing = await sftp.buildIndex(site.docroot, [...pullExclude, '.localdock/**']);
      const remoteFiles = remoteListing.filter((f) => !f.isDirectory);

      report(8, 'Comparing with local changes…');
      const engine = new DiffEngine();
      const remoteDiff = engine.computeRemoteChanges(remoteFiles, priorManifest);
      const localDiff = await engine.computeLocalChanges(localPath, priorManifest, pullExclude);
      const plan = planPull(remoteDiff, localDiff);
      conflicts = plan.conflicts;

      const filesToDownload = [...plan.safeDownloads];
      const filesToDelete = [...plan.safeDeletes];

      if (plan.conflicts.length > 0) {
        const items = plan.conflicts.map((c) => ({
          label: c.path,
          description: `you changed it locally (${c.localStatus}) · server changed it too (${c.remoteStatus})`,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          canPickMany: true,
          title: `${plan.conflicts.length} file(s) changed both locally and on the server`,
          placeHolder: 'Check any file to take the server\'s version instead — everything unchecked keeps your local version. Escape keeps everything local.',
        });
        for (const c of plan.conflicts) {
          const takeServerVersion = picked?.some((p) => p.label === c.path) ?? false;
          if (takeServerVersion) {
            if (c.remoteStatus === 'deleted') {
              filesToDelete.push(c.path);
            } else {
              filesToDownload.push(c.path);
            }
          }
        }
      }

      if (filesToDownload.length === 0 && filesToDelete.length === 0) {
        fileIndex = {};
        totalFiles = 0;
        failedFiles = [];
      } else {
        report(10, `Pulling ${filesToDownload.length} changed file(s)…`);
        const result = await fileSyncer.downloadChanged(site.docroot, localPath, filesToDownload, filesToDelete, token, progressAdapter);
        fileIndex = result.fileIndex;
        totalFiles = filesToDownload.length;
        failedFiles = result.failedFiles;
      }
      filesRemovedLocally = filesToDelete;
    }

    if (token.isCancellationRequested) {
      activityManager.cancel(opId);
      await siteTreeProvider.updateSiteState({ ...site, syncState: { status: 'not_pulled' } });
      return;
    }

    report(PULL_PROGRESS.FILES_END, 'Syncing database…');
    // This still downloads a full snapshot to .localdock/db.sql — that file
    // is only used to seed a fresh Docker volume on a full reset (first
    // start, a port change, etc.), so refreshing it doesn't touch the
    // running local database. Bringing specific changes into the *running*
    // database (without disturbing local-only content) is the incremental
    // step right below.
    await dbSyncer.pullDatabase({ ...site, dbPass: siteDbPass }, localPath, (msg) => report(PULL_PROGRESS.DB, msg));

    // Incremental database pull: bring down only the specific rows the
    // server's Companion changelog says changed since the last pull (e.g. an
    // option a plugin update touched), leaving everything else in the
    // running local database — including local-only content — untouched. A
    // row changed on both sides since the last pull is a conflict, resolved
    // the same way as file conflicts above.
    let dbPulled = 0;
    let dbConflicts: DbPullConflict[] = [];
    try {
      const localEnvRunning = priorManifest?.localPort
        ? (await dockerManager.getStatus(localPath)) === 'running'
        : false;
      const remoteApiKey = await credManager.getCompanionKey(site.id);
      const localApiKey = await credManager.getCompanionKeyLocal(site.id);

      if (localEnvRunning && remoteApiKey && localApiKey && priorManifest?.localPort) {
        report(PULL_PROGRESS.DB, 'Checking for database changes…');
        const [remotePlan, localPlan] = await Promise.all([
          planDatabasePush(`https://${site.domain}`, remoteApiKey, site.syncState.lastPulledAt, configManager.rejectUnauthorizedSsl),
          planDatabasePush(`http://localhost:${priorManifest.localPort}`, localApiKey, site.syncState.lastPulledAt),
        ]);

        if (remotePlan && localPlan) {
          const dbPlan = mergeDatabasePullPlan(remotePlan, localPlan);
          dbConflicts = dbPlan.conflicts;

          const optionNames = [...dbPlan.safeOptionNames];
          const postIds = [...dbPlan.safePostIds];
          const userIds = [...dbPlan.safeUserIds];

          if (dbPlan.conflicts.length > 0) {
            const items = dbPlan.conflicts.map((c) => ({
              label: `${c.kind}: ${c.key}`,
              description: 'you changed it locally too — check to take the server\'s version instead',
            }));
            const picked = await vscode.window.showQuickPick(items, {
              canPickMany: true,
              title: `${dbPlan.conflicts.length} database change(s) affect rows you also changed locally`,
              placeHolder: 'Check any to take the server\'s version. Leave unchecked (or press Escape) to keep your local version.',
            });
            for (const c of dbPlan.conflicts) {
              const takeServerVersion = picked?.some((p) => p.label === `${c.kind}: ${c.key}`) ?? false;
              if (!takeServerVersion) {
                continue;
              }
              if (c.kind === 'option') {
                optionNames.push(c.key as string);
              } else if (c.kind === 'post') {
                postIds.push(c.key as number);
              } else {
                userIds.push(c.key as number);
              }
            }
          }

          dbPulled = optionNames.length + postIds.length + userIds.length;
          if (dbPulled > 0) {
            report(PULL_PROGRESS.DB, 'Pulling database changes…');
            const sqlText = await fetchRemoteDatabaseRows(ssh, sftp, { ...site, dbPass: siteDbPass }, { optionNames, postIds, userIds });
            await applyDatabasePullSql(dockerManager, localPath, sqlText);
          }
        } else {
          logger.info('[pullSite] Incremental database pull unavailable (Companion not reachable on one or both sides) — running database left as-is.');
        }
      }
    } catch (err) {
      logger.warn(`[pullSite] Incremental database pull failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    report(PULL_PROGRESS.MANIFEST, 'Writing manifest…');
    // Start from the prior manifest's index so paths this pull never touched
    // (unchanged on the server, or changed only locally) keep their old
    // recorded state — that's what lets the next push still detect a
    // locally-changed-but-not-pulled file as changed, instead of pull
    // silently marking it "known" and hiding it from push's diff.
    const mergedFileIndex: SiteManifest['fileIndex'] = { ...(priorManifest?.fileIndex ?? {}), ...fileIndex };
    for (const relPath of filesRemovedLocally) {
      delete mergedFileIndex[relPath];
    }

    const manifest: SiteManifest = {
      version: 1,
      domain: site.domain,
      serverHost: server.host,
      serverId: server.id,
      pulledAt: new Date().toISOString(),
      wpVersion: site.wpVersion,
      dbName: site.dbName,
      dbLocalName: sanitizeDbName(site.domain),
      fileIndex: mergedFileIndex,
    };
    await writeManifest(localPath, manifest);

    activityManager.complete(opId);

    const finishedSite: WordPressSite = {
      ...site, localPath,
      syncState: { status: 'pulled', lastPulledAt: new Date().toISOString() },
    };
    await siteTreeProvider.updateSiteState(finishedSite);
    localDockerTreeProvider.refresh();

    logger.info(`[pullSite] Complete: ${site.domain}`);

    const conflictNote = conflicts.length > 0 ? ` ${conflicts.length} file(s) with local changes were left as-is unless you chose otherwise.` : '';
    const dbNote = dbPulled > 0
      ? ` ${dbPulled} database change(s) pulled in.`
      : dbConflicts.length > 0
        ? ` ${dbConflicts.length} database change(s) affected rows you also changed locally and were left as-is unless you chose otherwise.`
        : '';
    const pullSummary = !priorManifest
      ? `Pulled ${site.domain} — ${totalFiles} files downloaded.`
      : totalFiles > 0
        ? `Pulled ${site.domain} — ${totalFiles} changed file(s) updated.${conflictNote}${dbNote}`
        : `${site.domain} is already up to date.${conflictNote}${dbNote}`;

    const offerCompanionSetup = finishedSite.companionPlugin !== 'active';
    const choice = await vscode.window.showInformationMessage(
      pullSummary,
      'Start Local Environment',
      ...(offerCompanionSetup ? ['Set Up Companion Plugin'] : []),
      'Dismiss'
    );
    if (choice === 'Start Local Environment') {
      vscode.commands.executeCommand('localdockCpanel.startLocal', new SiteTreeItem(finishedSite));
    } else if (choice === 'Set Up Companion Plugin') {
      vscode.commands.executeCommand('localdockCpanel.provisionCompanionPlugin', new SiteTreeItem(finishedSite));
    }

    // Surfaced separately (not folded into the success message above) so it
    // doesn't get lost — these files are missing from the manifest even
    // though they may already be sitting on disk, which makes the next push
    // think it needs to "add" them all.
    if (failedFiles.length > 0) {
      logger.warn(`[pullSite] ${failedFiles.length} file(s) failed to download and are missing from the manifest: ${failedFiles.slice(0, 20).join(', ')}${failedFiles.length > 20 ? ', …' : ''}`);
      const retryChoice = await vscode.window.showWarningMessage(
        `${failedFiles.length} of ${totalFiles} file(s) failed to download for "${site.domain}" and are missing from the sync manifest — pushing now would show them as new/changed. Pull again to retry them, or check the Output log for details.`,
        'Pull Again',
        'Show Logs'
      );
      if (retryChoice === 'Pull Again') {
        vscode.commands.executeCommand('localdockCpanel.pullSite', item);
      } else if (retryChoice === 'Show Logs') {
        vscode.commands.executeCommand('localdockCpanel.showOutput');
      }
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    activityManager.fail(opId, message);
    await siteTreeProvider.updateSiteState({
      ...site, localPath,
      syncState: { status: 'error', lastError: message },
    });
    handleError('pullSite', err);
  } finally {
    sftp.close();
    await ssh.disconnect();
  }
}
