import * as vscode from 'vscode';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { SiteRegistry } from '../SiteRegistry';
import { CredentialManager } from '../auth/CredentialManager';
import { ActivityManager } from '../ActivityManager';
import { ConfigManager } from '../utils/configManager';
import { SshClient } from '../api/SshClient';
import { SftpClient } from '../api/SftpClient';
import { DiffEngine } from '../sync/DiffEngine';
import { readManifest } from '../sync/Manifest';
import { handleError } from '../utils/errors';

export async function checkRemoteDiff(
  item: SiteTreeItem,
  registry: SiteRegistry,
  credManager: CredentialManager,
  activityManager: ActivityManager,
  configManager: ConfigManager
): Promise<void> {
  const site = item.site;

  if (!site.localPath) {
    vscode.window.showWarningMessage(`"${site.domain}" has not been pulled yet.`);
    return;
  }

  const server = registry.getServer(site.serverId);
  if (!server) {
    vscode.window.showErrorMessage(`Server not found for "${site.domain}"`);
    return;
  }

  const creds = await credManager.get(site.serverId);
  if (!creds) {
    vscode.window.showErrorMessage(`No credentials found for server "${server.host}"`);
    return;
  }

  const manifest = await readManifest(site.localPath);
  if (!manifest) {
    vscode.window.showWarningMessage(`No manifest for "${site.domain}". Pull the site first.`);
    return;
  }

  const { id: opId, token } = activityManager.start(site.domain, site.serverId, 'check-remote');
  activityManager.update(opId, 5, 'Connecting to server…');

  const ssh = new SshClient();
  const sftp = new SftpClient();

  try {
    await ssh.connect(server, creds);
    await sftp.open(ssh);

    if (token.isCancellationRequested) {
      activityManager.cancel(opId);
      return;
    }

    activityManager.update(opId, 15, 'Indexing remote files…');

    let indexedCount = 0;
    const remoteEntries = await sftp.buildIndex(
      site.docroot,
      [...configManager.excludePatterns, '.localdock/**'],
      (count) => {
        if (count !== indexedCount) {
          indexedCount = count;
          activityManager.update(
            opId,
            15 + Math.min(Math.floor((count / 500) * 70), 70),
            `Indexing remote files… (${count} found)`
          );
        }
      }
    );

    if (token.isCancellationRequested) {
      activityManager.cancel(opId);
      return;
    }

    activityManager.update(opId, 90, 'Computing diff…');

    const engine = new DiffEngine();
    const diff = engine.computeRemoteChanges(
      remoteEntries.filter((f) => !f.isDirectory),
      manifest
    );

    activityManager.complete(opId);

    const pulledDate = new Date(manifest.pulledAt).toLocaleDateString();

    if (!engine.hasChanges(diff)) {
      vscode.window.showInformationMessage(
        `"${site.domain}" is up to date — no remote changes since pull on ${pulledDate}.`
      );
      return;
    }

    const items: vscode.QuickPickItem[] = [
      {
        label: `$(warning) Remote has ${engine.formatSummary(diff)} since pull on ${pulledDate}`,
        alwaysShow: true,
      },
    ];

    if (diff.added.length > 0) {
      items.push(
        { label: `$(add) Added on server (${diff.added.length})`, kind: vscode.QuickPickItemKind.Separator },
        ...diff.added.map((f) => ({ label: f, description: 'new on server' }))
      );
    }

    if (diff.modified.length > 0) {
      items.push(
        { label: `$(edit) Modified on server (${diff.modified.length})`, kind: vscode.QuickPickItemKind.Separator },
        ...diff.modified.map((f) => ({ label: f, description: 'changed on server' }))
      );
    }

    if (diff.deleted.length > 0) {
      items.push(
        { label: `$(trash) Deleted on server (${diff.deleted.length})`, kind: vscode.QuickPickItemKind.Separator },
        ...diff.deleted.map((f) => ({ label: f, description: 'removed from server' }))
      );
    }

    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        label: '$(cloud-download) Pull now to get latest server changes',
        description: 'Overwrites local with server version',
        alwaysShow: true,
      }
    );

    const choice = await vscode.window.showQuickPick(items, {
      title: `Remote changes on ${site.domain} — ${engine.formatSummary(diff)}`,
      placeHolder: 'Remote changes since last pull. Select "Pull now" to sync.',
      canPickMany: false,
    });

    if (choice?.label.includes('Pull now')) {
      vscode.commands.executeCommand('localdockCpanel.pullSite', item);
    }

  } catch (err) {
    activityManager.fail(opId, err instanceof Error ? err.message : String(err));
    handleError('checkRemoteDiff', err);
  } finally {
    sftp.close();
    await ssh.disconnect();
  }
}
