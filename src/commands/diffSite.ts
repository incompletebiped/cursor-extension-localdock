import * as vscode from 'vscode';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { ConfigManager } from '../utils/configManager';
import { CredentialManager } from '../auth/CredentialManager';
import { DockerManager } from '../docker/DockerManager';
import { DiffEngine } from '../sync/DiffEngine';
import { planDatabasePush } from '../sync/ChangelogPushPlanner';
import { readManifest } from '../sync/Manifest';
import { WordPressSite } from '../models/Site';
import { handleError } from '../utils/errors';
import { logger } from '../utils/logger';

export async function diffSite(
  item: SiteTreeItem,
  treeProvider: SiteTreeProvider,
  configManager: ConfigManager,
  credManager: CredentialManager,
  dockerManager: DockerManager
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
      configManager.pushExcludePatterns
    );

    // Read-only equivalent of what pushSite would compute — same "since"
    // cursor, same Companion changelog — just without the confirmation
    // dialog or any actual mutation, so this is safe to run any time.
    let dbSummary: string | null = null;
    try {
      const localApiKey = await credManager.getCompanionKeyLocal(site.id);
      if (localApiKey && manifest.localPort && (await dockerManager.getStatus(site.localPath)) === 'running') {
        const dbPlan = await planDatabasePush(
          `http://localhost:${manifest.localPort}`,
          localApiKey,
          site.syncState.lastPushedAt ?? site.syncState.lastPulledAt
        );
        if (dbPlan && !dbPlan.isEmpty) {
          dbSummary = dbPlan.summary;
        }
      }
    } catch (err) {
      // Purely informational — never block the file diff view over this.
      logger.warn(`[diffSite] Database status check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!engine.hasChanges(diff) && !dbSummary) {
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

    if (dbSummary) {
      items.push(
        { label: '$(database) Database', kind: vscode.QuickPickItemKind.Separator },
        { label: `$(database) ${dbSummary}`, description: 'since last sync — via Companion Plugin' }
      );
    }

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

    const fileSummary = engine.hasChanges(diff) ? engine.formatSummary(diff) : null;
    const titleSummary = [fileSummary, dbSummary].filter(Boolean).join(' · ');

    await vscode.window.showQuickPick(items, {
      title: `Changes in ${site.domain} — ${titleSummary}`,
      placeHolder: 'Local changes (read-only view)',
      canPickMany: false,
    });
  } catch (err) {
    handleError('diffSite', err);
  }
}
