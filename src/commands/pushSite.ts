import * as vscode from 'vscode';
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
import { DiffEngine } from '../sync/DiffEngine';
import { WordPressSite } from '../models/Site';
import { handleError } from '../utils/errors';
import { logger } from '../utils/logger';

export async function pushSite(
  item: SiteTreeItem,
  registry: SiteRegistry,
  credManager: CredentialManager,
  treeProvider: SiteTreeProvider,
  activityManager: ActivityManager,
  configManager: ConfigManager
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
    configManager.excludePatterns
  );

  if (!engine.hasChanges(diff)) {
    vscode.window.showInformationMessage(`"${site.domain}" has no local changes to push.`);
    return;
  }

  // Show confirmation with change summary
  const changeItems: vscode.QuickPickItem[] = [
    ...diff.added.map((f) => ({ label: `$(add) ${f}`, description: 'will be uploaded' })),
    ...diff.modified.map((f) => ({ label: `$(edit) ${f}`, description: 'will be updated' })),
    ...diff.deleted.map((f) => ({ label: `$(trash) ${f}`, description: 'will be deleted' })),
  ];

  const confirm = await vscode.window.showQuickPick(
    [
      {
        label: `$(cloud-upload) Push ${engine.formatSummary(diff)} to ${site.domain}`,
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
    treeProvider.updateSiteState({
      ...updatedSite,
      syncState: { status: 'pushing', progress, message },
    }).catch(() => {});
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
            ? Math.round((parseInt(match[1]) / parseInt(match[2])) * 70) + 10 // 10–80%
            : undefined;
          report(pct ?? activityManager.getRunning().find(o => o.id === opId)?.progress ?? 0, message);
        }
      },
    };

    report(5, 'Uploading changed files…');
    const newFileIndex = await fileSyncer.uploadChanged(
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

    report(82, 'Pushing database…');
    await dbSyncer.pushDatabase(site, site.localPath!, (msg) => report(85, msg));

    report(97, 'Updating manifest…');
    const updatedManifest = {
      ...manifest,
      fileIndex: Object.fromEntries(
        Object.entries({ ...manifest.fileIndex, ...newFileIndex })
          .filter(([k]) => !diff.deleted.includes(k))
      ),
    };
    await writeManifest(site.localPath!, updatedManifest);

    activityManager.complete(opId);

    const finishedSite: WordPressSite = {
      ...site,
      syncState: {
        status: 'pulled',
        lastPulledAt: site.syncState.lastPulledAt,
        lastPushedAt: new Date().toISOString(),
      },
    };
    await treeProvider.updateSiteState(finishedSite);

    vscode.window.showInformationMessage(
      `Pushed ${site.domain} — ${engine.totalChanges(diff)} file(s) synced.`
    );
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
