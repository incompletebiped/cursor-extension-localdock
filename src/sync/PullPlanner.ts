import { DiffResult } from './DiffEngine';

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface PullConflict {
  path: string;
  localStatus: ChangeStatus;
  remoteStatus: ChangeStatus;
}

export interface PullPlan {
  /** Changed on the server only — safe to download/overwrite locally. */
  safeDownloads: string[];
  /** Deleted on the server only — safe to remove locally. */
  safeDeletes: string[];
  /** Changed on both sides since the last sync — needs a human decision. */
  conflicts: PullConflict[];
}

/**
 * Combines what changed on the server since the last sync with what changed
 * locally since the last sync (both diffed against the same manifest
 * baseline) to decide what a pull can bring down automatically versus what
 * needs a decision because both sides touched the same path — the file-sync
 * equivalent of a git merge conflict. A path untouched on the server is never
 * included here at all, regardless of local state, which is what stops pull
 * from re-downloading a theme/plugin folder you deliberately removed locally
 * but never pushed: the server's copy of that path is unchanged, so it's not
 * part of remoteDiff and this function never sees it.
 */
export function planPull(remoteDiff: DiffResult, localDiff: DiffResult): PullPlan {
  const localStatus = new Map<string, ChangeStatus>();
  for (const p of localDiff.added) {
    localStatus.set(p, 'added');
  }
  for (const p of localDiff.modified) {
    localStatus.set(p, 'modified');
  }
  for (const p of localDiff.deleted) {
    localStatus.set(p, 'deleted');
  }

  const safeDownloads: string[] = [];
  const safeDeletes: string[] = [];
  const conflicts: PullConflict[] = [];

  const classify = (paths: string[], remoteStatus: ChangeStatus, safeBucket: string[]) => {
    for (const p of paths) {
      const local = localStatus.get(p);
      if (local) {
        conflicts.push({ path: p, localStatus: local, remoteStatus });
      } else {
        safeBucket.push(p);
      }
    }
  };

  classify(remoteDiff.added, 'added', safeDownloads);
  classify(remoteDiff.modified, 'modified', safeDownloads);

  // Both sides independently deleting the same path isn't a real conflict —
  // there's nothing to choose between, they agree it should be gone.
  for (const p of remoteDiff.deleted) {
    if (localStatus.get(p) === 'deleted') {
      safeDeletes.push(p);
    } else if (localStatus.has(p)) {
      conflicts.push({ path: p, localStatus: localStatus.get(p)!, remoteStatus: 'deleted' });
    } else {
      safeDeletes.push(p);
    }
  }

  return { safeDownloads, safeDeletes, conflicts };
}
