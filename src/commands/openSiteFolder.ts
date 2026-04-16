import * as vscode from 'vscode';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { handleError } from '../utils/errors';

export async function openSiteFolder(item: SiteTreeItem): Promise<void> {
  try {
    if (!item.site.localPath) {
      vscode.window.showWarningMessage(
        `"${item.site.domain}" has not been pulled yet. Pull it first.`
      );
      return;
    }
    const uri = vscode.Uri.file(item.site.localPath);
    await vscode.commands.executeCommand('vscode.openFolder', uri, {
      forceNewWindow: false,
    });
  } catch (err) {
    handleError('openSiteFolder', err);
  }
}
