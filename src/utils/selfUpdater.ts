import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { logger } from './logger';
import { ConfigManager } from './configManager';

/** Compares dotted version strings numerically. Positive if `a` is newer than `b`. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function readRepoVersion(repoPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(repoPath, 'package.json'), 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: true, windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/** Best-effort removal of older installed versions, leaving the freshly installed one alone. */
async function cleanupOldVersions(extensionsDir: string, keepFolderName: string): Promise<void> {
  try {
    const entries = await fs.readdir(extensionsDir);
    const stale = entries.filter(
      (name) => name.startsWith('incompletebiped.localdock-cpanel-') && name !== keepFolderName
    );
    await Promise.all(
      stale.map((name) =>
        fs.rm(path.join(extensionsDir, name), { recursive: true, force: true }).catch((err) => {
          logger.warn(`[selfUpdater] Could not remove stale version ${name}: ${err}`);
        })
      )
    );
  } catch (err) {
    logger.warn(`[selfUpdater] Cleanup skipped: ${err}`);
  }
}

async function runUpdate(context: vscode.ExtensionContext, repoPath: string, newVersion: string): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Updating LocalDock' },
    async (progress) => {
      progress.report({ message: 'Building…' });
      await runCommand('npm', ['run', 'package'], repoPath);

      const vsixName = `localdock-cpanel-${newVersion}.vsix`;
      const vsixPath = path.join(repoPath, vsixName);
      try {
        await fs.access(vsixPath);
      } catch {
        throw new Error(`Expected package output not found: ${vsixPath}`);
      }

      progress.report({ message: 'Installing…' });
      await runCommand('cursor', ['--install-extension', vsixPath, '--force'], repoPath);

      progress.report({ message: 'Cleaning up…' });
      const extensionsDir = path.dirname(context.extensionPath);
      const keepFolderName = `incompletebiped.localdock-cpanel-${newVersion}`;
      await cleanupOldVersions(extensionsDir, keepFolderName);
    }
  );

  const choice = await vscode.window.showInformationMessage(
    `LocalDock updated to ${newVersion}. Reload the window to apply it.`,
    'Reload Now'
  );
  if (choice === 'Reload Now') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * Compares the running extension's version against its source repo's package.json
 * (set via `localdockCpanel.devRepoPath`) and offers to rebuild/reinstall/reload
 * when the repo is ahead. Developer-only workflow — no-op when devRepoPath is unset.
 */
export async function checkForUpdates(
  context: vscode.ExtensionContext,
  configManager: ConfigManager,
  options: { silent: boolean }
): Promise<void> {
  const repoPath = configManager.devRepoPath;
  if (!repoPath) {
    if (!options.silent) {
      const choice = await vscode.window.showWarningMessage(
        'Set "LocalDock: Dev Repo Path" in settings to enable update checks.',
        'Open Settings'
      );
      if (choice === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'localdockCpanel.devRepoPath');
      }
    }
    return;
  }

  const repoVersion = await readRepoVersion(repoPath);
  if (!repoVersion) {
    if (!options.silent) {
      vscode.window.showErrorMessage(`Could not read package.json version from ${repoPath}.`);
    }
    return;
  }

  const currentVersion = context.extension.packageJSON.version as string;

  if (compareVersions(repoVersion, currentVersion) <= 0) {
    if (!options.silent) {
      vscode.window.showInformationMessage(`LocalDock is up to date (${currentVersion}).`);
    }
    return;
  }

  logger.info(`[selfUpdater] Repo version ${repoVersion} is newer than installed ${currentVersion}.`);
  const choice = await vscode.window.showInformationMessage(
    `LocalDock ${repoVersion} is available in the repo (installed: ${currentVersion}).`,
    'Update Now',
    'Later'
  );
  if (choice !== 'Update Now') return;

  try {
    await runUpdate(context, repoPath, repoVersion);
  } catch (err) {
    logger.error(`[selfUpdater] Update failed: ${err}`);
    vscode.window.showErrorMessage(`LocalDock update failed: ${err instanceof Error ? err.message : err}`);
  }
}
