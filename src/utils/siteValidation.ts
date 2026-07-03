import * as fs from 'fs/promises';
import { WordPressSite } from '../models/Site';
import { DockerManager } from '../docker/DockerManager';

/**
 * Reconciles a site's local state against what's actually on disk and in Docker.
 * Handles the case where the user deletes a pulled site's folder outside the
 * extension: the registry would otherwise keep showing it as pulled (and keep
 * listing it under Local Environments) forever, since nothing else notices the
 * folder is gone. Called on activation and on every "Refresh Sites" so the UI
 * self-heals without requiring a window reload.
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
    let pathExists = false;
    try {
      await fs.access(site.localPath);
      pathExists = true;
    } catch {
      // deleted outside the extension
    }
    if (!pathExists) {
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
