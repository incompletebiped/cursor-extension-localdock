import * as vscode from 'vscode';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { SiteRegistry } from '../SiteRegistry';
import { CredentialManager } from '../auth/CredentialManager';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { ConfigManager } from '../utils/configManager';
import { fetchCompanionChanges } from '../api/CompanionPluginClient';
import { handleError } from '../utils/errors';

function formatTimestamp(mysqlUtc: string): string {
  // MySQL DATETIME has no timezone marker; the plugin writes it in UTC (current_time('mysql', true)).
  return new Date(mysqlUtc.replace(' ', 'T') + 'Z').toLocaleString();
}

export async function checkCompanionDrift(
  item: SiteTreeItem,
  registry: SiteRegistry,
  credManager: CredentialManager,
  siteTreeProvider: SiteTreeProvider,
  configManager: ConfigManager
): Promise<void> {
  const site = item.site;

  const apiKey = await credManager.getCompanionKey(site.id);
  if (!apiKey) {
    const choice = await vscode.window.showWarningMessage(
      `LocalDock Companion isn't provisioned for "${site.domain}" yet.`,
      'Provision Now'
    );
    if (choice === 'Provision Now') {
      vscode.commands.executeCommand('localdockCpanel.provisionCompanionPlugin', item);
    }
    return;
  }

  try {
    const result = await fetchCompanionChanges(
      site.domain,
      apiKey,
      site.syncState.lastPulledAt,
      configManager.rejectUnauthorizedSsl
    );

    if (!result.ok) {
      if (result.reason === 'unauthorized') {
        const invalidated = { ...site, companionKeyStatus: 'invalid' as const };
        await registry.updateSite(invalidated);
        await siteTreeProvider.updateSiteState(invalidated);
        const choice = await vscode.window.showWarningMessage(
          `"${site.domain}"'s stored Companion API key was rejected — it may have been regenerated on the site. Re-provision?`,
          'Provision Now'
        );
        if (choice === 'Provision Now') {
          vscode.commands.executeCommand('localdockCpanel.provisionCompanionPlugin', item);
        }
        return;
      }

      if (result.reason === 'not_found') {
        const notInstalled = { ...site, companionPlugin: 'not_installed' as const };
        await registry.updateSite(notInstalled);
        await siteTreeProvider.updateSiteState(notInstalled);
        vscode.window.showWarningMessage(
          `Companion plugin no longer found on "${site.domain}" — it may have been deactivated or removed.`
        );
        return;
      }

      vscode.window.showErrorMessage(`Companion check failed for "${site.domain}": ${result.message}`);
      return;
    }

    if (site.companionKeyStatus !== 'valid' || site.companionPlugin !== 'active') {
      const refreshed = { ...site, companionPlugin: 'active' as const, companionKeyStatus: 'valid' as const };
      await registry.updateSite(refreshed);
      await siteTreeProvider.updateSiteState(refreshed);
    }

    const pulledLabel = site.syncState.lastPulledAt
      ? `since pull on ${new Date(site.syncState.lastPulledAt).toLocaleDateString()}`
      : 'in its tracked history';

    if (result.changes.length === 0) {
      vscode.window.showInformationMessage(
        `"${site.domain}" is up to date — no changes ${pulledLabel} (via Companion Plugin).`
      );
      return;
    }

    const items: vscode.QuickPickItem[] = [
      {
        label: `$(warning) ${result.changes.length} change${result.changes.length !== 1 ? 's' : ''} ${pulledLabel}`,
        alwaysShow: true,
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...result.changes.slice(0, 50).map((c) => ({
        label: `${c.object_type}${c.object_id !== null ? ` #${c.object_id}` : ''}`,
        description: `${c.action} · ${formatTimestamp(c.created_at)}`,
      })),
    ];

    if (site.localPath) {
      items.push(
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(cloud-download) Pull now to get latest server changes', alwaysShow: true }
      );
    }

    const choice = await vscode.window.showQuickPick(items, {
      title: `Remote changes on ${site.domain}`,
      placeHolder: 'Changes reported by the Companion Plugin since your last pull.',
    });

    if (choice?.label.includes('Pull now')) {
      vscode.commands.executeCommand('localdockCpanel.pullSite', item);
    }
  } catch (err) {
    handleError('checkCompanionDrift', err);
  }
}
