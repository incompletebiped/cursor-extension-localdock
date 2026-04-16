import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
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
import { writeManifest } from '../sync/Manifest';
import { WordPressSite } from '../models/Site';
import { SiteManifest } from '../models/Manifest';
import { sanitizeDbName } from '../utils/pathUtils';
import { handleError } from '../utils/errors';
import { logger } from '../utils/logger';

function resolveLocalPath(domain: string, configManager: ConfigManager): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    return path.join(workspaceFolders[0].uri.fsPath, domain);
  }
  const configured = configManager.localSitesDirectory;
  if (configured) {
    return path.join(configured, domain);
  }
  return path.join(os.homedir(), 'localwp-sites', domain);
}

export async function pullSite(
  item: SiteTreeItem,
  registry: SiteRegistry,
  credManager: CredentialManager,
  siteTreeProvider: SiteTreeProvider,
  activityManager: ActivityManager,
  configManager: ConfigManager
): Promise<void> {
  const site = item.site;
  const server = registry.getServers().find((s) => s.id === site.serverId);
  if (!server) {
    vscode.window.showErrorMessage(`Server not found for "${site.domain}"`);
    return;
  }

  const creds = await credManager.get(site.serverId);
  if (!creds) {
    vscode.window.showErrorMessage(`No credentials for server "${server.host}"`);
    return;
  }

  const localPath = resolveLocalPath(site.domain, configManager);
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
    siteTreeProvider.updateSiteState({
      ...updatedSite,
      syncState: { status: 'pulling', progress, message },
    }).catch(() => {});
  };

  try {
    await ssh.connect(server, creds);
    await sftp.open(ssh);

    if (token.isCancellationRequested) {
      activityManager.cancel(opId);
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

    // Use a fake vscode.Progress adapter so FileSyncer can report through ActivityManager
    const progressAdapter = {
      report: ({ message }: { message?: string; increment?: number }) => {
        if (message) {
          // Extract percentage from messages like "Downloading files… (42 / 100)"
          const match = message.match(/\((\d+) \/ (\d+)\)/);
          const pct = match
            ? Math.round((parseInt(match[1]) / parseInt(match[2])) * 80) + 10 // 10–90%
            : undefined;
          report(pct ?? activityManager.getRunning().find(o => o.id === opId)?.progress ?? 0, message);
        }
      },
    };

    report(5, 'Indexing remote files…');
    const { fileIndex, totalFiles } = await fileSyncer.downloadAll(
      site.docroot,
      localPath,
      configManager.excludePatterns,
      token,
      progressAdapter
    );

    if (token.isCancellationRequested) {
      activityManager.cancel(opId);
      await siteTreeProvider.updateSiteState({ ...site, syncState: { status: 'not_pulled' } });
      return;
    }

    report(90, 'Syncing database…');
    await dbSyncer.pullDatabase(site, localPath, (msg) => report(92, msg));

    report(98, 'Writing manifest…');
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

    vscode.window.showInformationMessage(
      `Pulled ${site.domain} — ${totalFiles} files downloaded.`
    );
    logger.info(`[pullSite] Complete: ${site.domain}`);

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
