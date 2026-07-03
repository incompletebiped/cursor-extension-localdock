import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import { logger } from './logger';

/**
 * Result of checking whether a filesystem path lives on a drive that Docker
 * Desktop can bind-mount read-write.
 *
 * Docker Desktop on Windows (WSL2 backend) only mounts FIXED NTFS/ReFS drives
 * read-write. Removable drives, exFAT/FAT volumes, and network (UNC) shares are
 * mounted read-only — so `docker compose up` fails with "read-only file system"
 * the moment it tries to bind-mount the site folder. This check lets the
 * extension catch that *before* a pull or a local-env start, instead of failing
 * deep inside Docker with a cryptic message.
 */
export interface DriveEligibility {
  /** True if the path's drive can back a Docker bind mount. */
  eligible: boolean;
  driveLetter?: string;
  /** Fixed | Removable | Network | CD-ROM | RAM | Unknown */
  driveType?: string;
  /** NTFS | ReFS | exFAT | FAT32 | … */
  fileSystem?: string;
  /** Human-readable explanation when not eligible. */
  reason?: string;
}

const ELIGIBLE_FILESYSTEMS = ['NTFS', 'ReFS'];

// Drive characteristics rarely change within a session — cache by drive letter
// so repeated tree refreshes don't each spawn a PowerShell process.
const cache = new Map<string, DriveEligibility>();

/** Clear cached results (e.g. before an interactive folder pick, in case drives changed). */
export function clearDriveEligibilityCache(): void {
  cache.clear();
}

function getTrustedDrives(): Set<string> {
  const list = vscode.workspace
    .getConfiguration('localdockCpanel')
    .get<string[]>('trustedRemovableDrives', []);
  return new Set(list.map((d) => d.replace(/[:\\/]/g, '').toUpperCase()));
}

/**
 * Marks a removable drive as trusted for Docker bind-mounts (e.g. an SD card
 * or USB drive that's effectively permanently attached) and invalidates the
 * cached eligibility result for it so the next check picks up the change.
 */
export async function trustRemovableDrive(driveLetter: string): Promise<void> {
  const letter = driveLetter.replace(/[:\\/]/g, '').toUpperCase();
  const config = vscode.workspace.getConfiguration('localdockCpanel');
  const current = config.get<string[]>('trustedRemovableDrives', []);
  if (!current.includes(letter)) {
    await config.update('trustedRemovableDrives', [...current, letter], vscode.ConfigurationTarget.Global);
  }
  cache.delete(letter);
}

/**
 * True when a drive was rejected only for being non-fixed (removable/hot-swappable)
 * while its filesystem is otherwise Docker-compatible (NTFS/ReFS) — i.e. a drive
 * the user could reasonably choose to trust rather than one that's fundamentally
 * incompatible (exFAT/FAT/network).
 */
export function isTrustCandidate(eligibility: DriveEligibility): boolean {
  return (
    !eligibility.eligible &&
    eligibility.driveType === 'Removable' &&
    !!eligibility.fileSystem &&
    ELIGIBLE_FILESYSTEMS.includes(eligibility.fileSystem)
  );
}

/**
 * Determine whether `targetPath` is on a Docker-mountable drive.
 * Non-Windows platforms always return eligible (the constraint is Windows-only).
 * When the drive type can't be determined, returns eligible to avoid false
 * negatives — the reactive error in DockerManager.start() remains the backstop.
 */
export async function checkDriveEligibility(targetPath: string): Promise<DriveEligibility> {
  if (process.platform !== 'win32') {
    return { eligible: true };
  }

  // UNC / network share paths can never be bind-mounted.
  if (targetPath.startsWith('\\\\') || targetPath.startsWith('//')) {
    return {
      eligible: false,
      driveType: 'Network',
      reason: "Network shares (UNC paths) can't be bind-mounted by Docker Desktop. Choose a folder on a fixed NTFS drive such as C:.",
    };
  }

  const driveLetter = path.parse(targetPath).root.replace(/[:\\/]/g, '').toUpperCase();
  if (!/^[A-Z]$/.test(driveLetter)) {
    return { eligible: true }; // can't determine a drive letter — don't block
  }

  const cached = cache.get(driveLetter);
  if (cached) {
    return cached;
  }

  const result = await queryVolume(driveLetter);
  cache.set(driveLetter, result);
  return result;
}

function queryVolume(driveLetter: string): Promise<DriveEligibility> {
  return new Promise((resolve) => {
    const script =
      `$ErrorActionPreference='Stop';` +
      `$v = Get-Volume -DriveLetter ${driveLetter};` +
      `[pscustomobject]@{DriveType=[string]$v.DriveType;FileSystemType=[string]$v.FileSystemType}|ConvertTo-Json -Compress`;

    const proc = child_process.spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true }
    );

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      logger.warn(`[driveEligibility] Could not query drive ${driveLetter}: ${err.message}`);
      resolve({ eligible: true, driveLetter }); // undetermined — don't block
    });

    proc.on('close', () => {
      try {
        const parsed = JSON.parse(stdout.trim()) as { DriveType?: string; FileSystemType?: string };
        const driveType = String(parsed.DriveType ?? '');
        const fileSystem = String(parsed.FileSystemType ?? '');
        const fsOk = ELIGIBLE_FILESYSTEMS.includes(fileSystem);
        const trusted = driveType === 'Removable' && fsOk && getTrustedDrives().has(driveLetter);
        const eligible = (driveType === 'Fixed' && fsOk) || trusted;
        resolve({
          eligible,
          driveLetter,
          driveType,
          fileSystem,
          reason: eligible ? undefined : buildReason(driveLetter, driveType, fileSystem),
        });
      } catch {
        logger.warn(`[driveEligibility] Unparseable volume info for ${driveLetter}: ${stdout || stderr}`);
        resolve({ eligible: true, driveLetter }); // undetermined — don't block
      }
    });
  });
}

function buildReason(driveLetter: string, driveType: string, fileSystem: string): string {
  const parts: string[] = [];
  if (driveType && driveType !== 'Fixed') {
    parts.push(`a ${driveType.toLowerCase()} drive`);
  }
  if (fileSystem && !ELIGIBLE_FILESYSTEMS.includes(fileSystem)) {
    parts.push(`formatted as ${fileSystem}`);
  }
  const detail = parts.length ? ` (${parts.join(', ')})` : '';
  return (
    `Drive ${driveLetter}:${detail} can't host local sites — Docker Desktop only bind-mounts ` +
    `fixed NTFS/ReFS drives read-write. Choose a folder on a fixed NTFS drive such as C:.`
  );
}
