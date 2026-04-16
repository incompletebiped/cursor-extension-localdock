import * as vscode from 'vscode';
import { SiteRegistry } from '../SiteRegistry';
import { CredentialManager } from '../auth/CredentialManager';
import { ServerTreeProvider, ServerTreeItem } from '../tree/ServerTreeProvider';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { handleError } from '../utils/errors';

export async function removeServer(
  item: ServerTreeItem,
  registry: SiteRegistry,
  credManager: CredentialManager,
  serverTreeProvider: ServerTreeProvider,
  siteTreeProvider: SiteTreeProvider
): Promise<void> {
  try {
    const confirm = await vscode.window.showWarningMessage(
      `Remove server "${item.server.label}"? This will delete stored credentials and the site list.`,
      { modal: true },
      'Remove'
    );
    if (confirm !== 'Remove') {
      return;
    }

    await credManager.delete(item.server.id);
    await registry.removeServer(item.server.id);

    serverTreeProvider.refresh();
    siteTreeProvider.refresh();
  } catch (err) {
    handleError('removeServer', err);
  }
}
