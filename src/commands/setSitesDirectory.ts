import * as vscode from 'vscode';
import { checkDriveEligibility, clearDriveEligibilityCache } from '../utils/driveEligibility';
import { resolveSitesBaseDir } from '../utils/locations';
import { logger } from '../utils/logger';

/**
 * Prompt the user to choose a local sites directory via a folder picker, gating
 * the selection on drive eligibility. An ineligible drive (removable / exFAT /
 * network) is rejected with an explanation and the user is re-prompted.
 *
 * Returns the chosen directory, or undefined if cancelled.
 */
export async function setSitesDirectory(): Promise<string | undefined> {
  clearDriveEligibilityCache(); // drives may have been mounted/removed since last check

  const current = resolveSitesBaseDir();

  // Re-prompt loop so an ineligible pick doesn't dead-end the user.
  for (;;) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Use This Folder',
      title: 'Select Local Sites Folder (must be on a fixed NTFS drive)',
      defaultUri: vscode.Uri.file(current),
    });

    if (!picked || picked.length === 0) {
      return undefined; // cancelled
    }

    const dir = picked[0].fsPath;
    const eligibility = await checkDriveEligibility(dir);

    if (!eligibility.eligible) {
      logger.warn(`[setSitesDirectory] Rejected ineligible folder ${dir}: ${eligibility.reason}`);
      const choice = await vscode.window.showErrorMessage(
        eligibility.reason ?? "That folder is on a drive Docker Desktop can't use.",
        'Choose Another Folder'
      );
      if (choice === 'Choose Another Folder') {
        continue;
      }
      return undefined;
    }

    await vscode.workspace
      .getConfiguration('localdockCpanel')
      .update('localSitesDirectory', dir, vscode.ConfigurationTarget.Global);

    logger.info(`[setSitesDirectory] Local sites folder set to ${dir}`);
    vscode.window.showInformationMessage(`Local sites folder set to ${dir}`);
    return dir;
  }
}
