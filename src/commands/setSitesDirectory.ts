import * as vscode from 'vscode';
import { checkDriveEligibility, clearDriveEligibilityCache, isTrustCandidate, trustRemovableDrive } from '../utils/driveEligibility';
import { resolveSitesBaseDir } from '../utils/locations';
import { logger } from '../utils/logger';

/**
 * Prompt the user to choose a local sites directory via a folder picker, gating
 * the selection on drive eligibility. An ineligible drive (removable / exFAT /
 * network) is rejected with an explanation and the user is re-prompted — unless
 * it's removable but NTFS/ReFS, in which case they can choose to trust it (e.g.
 * an SD card that's effectively permanently attached).
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

      const canTrust = isTrustCandidate(eligibility);
      const buttons = canTrust ? ['Trust This Drive', 'Choose Another Folder'] : ['Choose Another Folder'];
      const choice = await vscode.window.showErrorMessage(
        eligibility.reason ?? "That folder is on a drive Docker Desktop can't use.",
        ...buttons
      );

      if (choice === 'Trust This Drive' && eligibility.driveLetter) {
        await trustRemovableDrive(eligibility.driveLetter);
        logger.info(`[setSitesDirectory] Drive ${eligibility.driveLetter}: marked as trusted for Docker bind-mounts`);
        // Re-check now that the drive is trusted — falls through to the normal save path below.
        const recheck = await checkDriveEligibility(dir);
        if (!recheck.eligible) {
          // Shouldn't happen, but don't silently proceed on an actually-ineligible drive.
          vscode.window.showErrorMessage(recheck.reason ?? "That folder is still on a drive Docker Desktop can't use.");
          continue;
        }
      } else if (choice === 'Choose Another Folder') {
        continue;
      } else {
        return undefined;
      }
    }

    await vscode.workspace
      .getConfiguration('localdockCpanel')
      .update('localSitesDirectory', dir, vscode.ConfigurationTarget.Global);

    logger.info(`[setSitesDirectory] Local sites folder set to ${dir}`);
    vscode.window.showInformationMessage(`Local sites folder set to ${dir}`);
    return dir;
  }
}
