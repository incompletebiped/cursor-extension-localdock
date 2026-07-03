import * as path from 'path';
import { WordPressSite } from '../models/Site';
import { DockerManager } from '../docker/DockerManager';
import { readManifest } from '../sync/Manifest';
import { resolveSitesBaseDir } from './locations';

/** True if `childPath` is inside (or equal to) `parentDir`, comparing case-insensitively. */
function isUnderDir(childPath: string, parentDir: string): boolean {
  const rel = path.relative(parentDir.toLowerCase(), childPath.toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Reconciles a site's local state against what's actually on disk and in Docker.
 * Handles two ways a site's registry state can drift from reality:
 *
 *  1. The pulled folder was deleted (or emptied) outside the extension. Checks
 *     for `.localdock/manifest.json` rather than just the folder itself — a
 *     folder that survives a "select all inside, delete" still passes a bare
 *     existence check, but the manifest written on pull is gone along with
 *     everything else, so it's a reliable signal for "this is still a genuine
 *     pulled copy."
 *  2. The site was pulled under a since-changed `localSitesDirectory` (e.g. an
 *     old drive). Changing that setting only affects future pulls — it doesn't
 *     move anything already on disk — so a site sitting outside the *current*
 *     Local Sites Folder is treated as not pulled even if its old folder is
 *     still fully intact, matching "only sites on the selected drive count."
 *
 * Called on activation and on every "Refresh Sites" so the UI self-heals
 * without requiring a window reload.
 */
export async function reconcileLocalState(
  site: WordPressSite,
  dockerManager: DockerManager
): Promise<WordPressSite> {
  const status = site.syncState.status;

  if (
    site.localPath &&
    (status === 'pulled' || status === 'modified' || status === 'error' || status === 'pulling' || status === 'pushing')
  ) {
    const withinCurrentSitesDir = isUnderDir(site.localPath, resolveSitesBaseDir());
    const manifest = withinCurrentSitesDir ? await readManifest(site.localPath) : null;
    if (!manifest) {
      return {
        ...site,
        localPath: undefined,
        localEnv: undefined,
        syncState: { status: 'not_pulled' },
      };
    }
  }

  // Folder is present — but the Docker containers backing it (in particular the
  // db) may have been removed independently (e.g. `docker system prune`).
  if (site.localEnv?.status === 'running' && site.localPath) {
    const actual = await dockerManager.getStatus(site.localPath).catch(() => 'stopped' as const);
    if (actual !== 'running') {
      return { ...site, localEnv: { ...site.localEnv, status: actual } };
    }
  }

  return site;
}
