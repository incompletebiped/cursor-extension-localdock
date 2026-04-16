import * as vscode from 'vscode';
import { WordPressSite } from '../models/Site';

export async function openLocalSite(site: WordPressSite): Promise<void> {
  if (!site.localEnv?.url) {
    vscode.window.showWarningMessage(`No local URL found for ${site.domain}. Start the local environment first.`);
    return;
  }

  if (site.localEnv.status !== 'running') {
    vscode.window.showWarningMessage(`Local environment for ${site.domain} is not running.`);
    return;
  }

  await vscode.commands.executeCommand('simpleBrowser.show', site.localEnv.url);
}
