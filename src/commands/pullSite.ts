import * as vscode from 'vscode';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { LocalDockerTreeProvider } from '../tree/LocalDockerTreeProvider';
import { ActivityManager } from '../ActivityManager';
import { CredentialManager } from '../auth/CredentialManager';
import { ConfigManager } from '../utils/configManager';
import { SiteRegistry } from '../SiteRegistry';
import { SshClient } from '../api/SshClient';
import { SftpClient } from '../api/SftpClient';
import { FileSyncer } from '../sync/FileSyncer';
import { DatabaseSyncer } from '../sync/DatabaseSyncer';
import { writeManifest } from '../sync/Manifest';
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
  configManager: ConfigManager
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
    await ssh.connect(server, creds);
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

    report(5, 'Indexing remote files…');
    const { fileIndex, totalFiles } = await fileSyncer.downloadAll(
      site.docroot,
      localPath,
      pullExclude,
      token,
      progressAdapter
    );

    if (token.isCancellationRequested) {
      activityManager.cancel(opId);
      await siteTreeProvider.updateSiteState({ ...site, syncState: { status: 'not_pulled' } });
      return;
    }

    report(PULL_PROGRESS.FILES_END, 'Syncing database…');
    await dbSyncer.pullDatabase({ ...site, dbPass: siteDbPass }, localPath, (msg) => report(PULL_PROGRESS.DB, msg));

    report(PULL_PROGRESS.MANIFEST, 'Writing manifest…');
    const manifest: SiteManifest = {
      version: 1,
      domain: site.domain,
      serverHost: server.host,
      serverId: server.id,
      pulledAt: new Date().toISOString(),
      wpVersion: site.wpVersion,
      dbName: site.dbName,
      dbLocalName: sanitizeDbName(site.domain),
      fileIndex,
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

    const offerCompanionSetup = finishedSite.companionPlugin !== 'active';
    const choice = await vscode.window.showInformationMessage(
      `Pulled ${site.domain} — ${totalFiles} files downloaded.`,
      'Start Local Environment',
      ...(offerCompanionSetup ? ['Set Up Companion Plugin'] : []),
      'Dismiss'
    );
    if (choice === 'Start Local Environment') {
      vscode.commands.executeCommand('localdockCpanel.startLocal', new SiteTreeItem(finishedSite));
    } else if (choice === 'Set Up Companion Plugin') {
      vscode.commands.executeCommand('localdockCpanel.provisionCompanionPlugin', new SiteTreeItem(finishedSite));
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
