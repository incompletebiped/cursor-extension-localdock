import * as fs from 'fs/promises';
import * as path from 'path';
import { SiteManifest } from '../models/Manifest';
import { computeMd5 } from './FileSyncer';
import { logger } from '../utils/logger';

export interface DiffResult {
  added: string[];
  modified: string[];
  deleted: string[];
}

export class DiffEngine {
  /** Walk local files and compare against manifest checksums */
  async computeLocalChanges(
    localBase: string,
    manifest: SiteManifest,
    excludePatterns: string[]
  ): Promise<DiffResult> {
    const localFiles = await walkDir(localBase, localBase, [
      ...excludePatterns,
      '.localdock',
    ]);

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    const localSet = new Set(localFiles);

    for (const relPath of localFiles) {
      if (!manifest.fileIndex[relPath]) {
        added.push(relPath);
        continue;
      }

      const entry = manifest.fileIndex[relPath];
      const fullPath = path.join(localBase, relPath);

      try {
        const stat = await fs.stat(fullPath);

        // Fast path: size match + mtime match → likely unchanged
        if (
          stat.size === entry.size &&
          Math.floor(stat.mtimeMs / 1000) === entry.mtime
        ) {
          continue;
        }

        // Slow path: compute MD5 to confirm
        const md5 = await computeMd5(fullPath);
        if (md5 !== entry.md5) {
          modified.push(relPath);
        }
      } catch {
        // File listed in walk but stat failed — skip
        logger.warn(`[DiffEngine] Could not stat local file: ${fullPath}`);
      }
    }

    for (const manifestPath of Object.keys(manifest.fileIndex)) {
      if (!localSet.has(manifestPath)) {
        deleted.push(manifestPath);
      }
    }

    logger.info(
      `[DiffEngine] Diff: +${added.length} ~${modified.length} -${deleted.length}`
    );

    return { added, modified, deleted };
  }

  /** Compare a live remote file listing against the stored manifest (size+mtime, no download needed). */
  computeRemoteChanges(
    remoteFiles: Array<{ relativePath: string; size: number; mtime: number }>,
    manifest: SiteManifest
  ): DiffResult {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    const remoteMap = new Map(remoteFiles.map((f) => [f.relativePath, f]));

    for (const [relPath, remote] of remoteMap) {
      const entry = manifest.fileIndex[relPath];
      if (!entry) {
        added.push(relPath);
      } else if (remote.size !== entry.size || remote.mtime !== entry.mtime) {
        modified.push(relPath);
      }
    }

    for (const manifestPath of Object.keys(manifest.fileIndex)) {
      if (!remoteMap.has(manifestPath)) {
        deleted.push(manifestPath);
      }
    }

    logger.info(`[DiffEngine] Remote diff: +${added.length} ~${modified.length} -${deleted.length}`);
    return { added, modified, deleted };
  }

  hasChanges(diff: DiffResult): boolean {
    return diff.added.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0;
  }

  totalChanges(diff: DiffResult): number {
    return diff.added.length + diff.modified.length + diff.deleted.length;
  }

  formatSummary(diff: DiffResult): string {
    const parts: string[] = [];
    if (diff.added.length > 0) {
      parts.push(`${diff.added.length} added`);
    }
    if (diff.modified.length > 0) {
      parts.push(`${diff.modified.length} modified`);
    }
    if (diff.deleted.length > 0) {
      parts.push(`${diff.deleted.length} deleted`);
    }
    return parts.length > 0 ? parts.join(', ') : 'no changes';
  }
}

async function walkDir(
  base: string,
  current: string,
  exclude: string[]
): Promise<string[]> {
  const results: string[] = [];

  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const relativePath = fullPath.slice(base.length + 1).replace(/\\/g, '/');

    if (exclude.some((ex) => relativePath === ex || relativePath.startsWith(ex + '/'))) {
      continue;
    }

    if (entry.isDirectory()) {
      const children = await walkDir(base, fullPath, exclude);
      results.push(...children);
    } else {
      results.push(relativePath);
    }
  }

  return results;
}
