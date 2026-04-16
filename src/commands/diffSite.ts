import * as vscode from 'vscode';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { ConfigManager } from '../utils/configManager';
import { DiffEngine } from '../sync/DiffEngine';
import { readManifest } from '../sync/Manifest';
import { WordPressSite } from '../models/Site';
import { handleError } from '../utils/errors';

export async function diffSite(
  item: SiteTreeItem,
  treeProvider: SiteTreeProvider,
  configManager: ConfigManager
): Promise<void> {
  const site = item.site;

  if (!site.localPath) {
    vscode.window.showWarningMessage(
      `"${site.domain}" has not been pulled yet.`
    );
    return;
  }

  try {
    const manifest = await readManifest(site.localPath);
    if (!manifest) {
      vscode.window.showWarningMessage(
        `No manifest found for "${site.domain}". Pull the site first.`
      );
      return;
    }

    const engine = new DiffEngine();
    const diff = await engine.computeLocalChanges(
      site.localPath,
      manifest,
      configManager.excludePatterns
    );

    if (!engine.hasChanges(diff)) {
      vscode.window.showInformationMessage(`"${site.domain}" has no local changes.`);
      return;
    }

    // Update site's localChanges count in registry
    const updatedSite: WordPressSite = {
      ...site,
      syncState: {
        ...site.syncState,
        status: 'modified',
        localChanges: engine.totalChanges(diff),
      },
    };
    await treeProvider.updateSiteState(updatedSite);

    // Show results in quick pick for easy browsing
    const items: vscode.QuickPickItem[] = [];

    if (diff.added.length > 0) {
      items.push({
        label: `$(add) Added (${diff.added.length})`,
        kind: vscode.QuickPickItemKind.Separator,
      });
      items.push(
        ...diff.added.map((f) => ({ label: f, description: 'added' }))
      );
    }

    if (diff.modified.length > 0) {
      items.push({
        label: `$(edit) Modified (${diff.modified.length})`,
        kind: vscode.QuickPickItemKind.Separator,
      });
      items.push(
        ...diff.modified.map((f) => ({ label: f, description: 'modified' }))
      );
    }

    if (diff.deleted.length > 0) {
      items.push({
        label: `$(trash) Deleted (${diff.deleted.length})`,
        kind: vscode.QuickPickItemKind.Separator,
      });
      items.push(
        ...diff.deleted.map((f) => ({ label: f, description: 'deleted' }))
      );
    }

    await vscode.window.showQuickPick(items, {
      title: `Changes in ${site.domain} — ${engine.formatSummary(diff)}`,
      placeHolder: 'Local changes (read-only view)',
      canPickMany: false,
    });
  } catch (err) {
    handleError('diffSite', err);
  }
}
