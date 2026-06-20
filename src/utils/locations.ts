import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

/**
 * Resolve the base directory where pulled sites are stored.
 *
 * Precedence:
 *  1. An explicitly-configured `localdockCpanel.localSitesDirectory` — always wins,
 *     because the open workspace folder may live on a drive Docker Desktop can't
 *     bind-mount (removable / exFAT / network).
 *  2. The first open workspace folder.
 *  3. `~/localdock-sites` (always on the user's home drive).
 */
export function resolveSitesBaseDir(): string {
  const configuredRaw = vscode.workspace
    .getConfiguration('localdockCpanel')
    .get<string>('localSitesDirectory', '');
  if (configuredRaw) {
    return configuredRaw;
  }
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    return workspaceFolders[0].uri.fsPath;
  }
  return path.join(os.homedir(), 'localdock-sites');
}

/** Resolve the local directory for a specific site domain. */
export function resolveLocalSitePath(domain: string): string {
  return path.join(resolveSitesBaseDir(), domain);
}
