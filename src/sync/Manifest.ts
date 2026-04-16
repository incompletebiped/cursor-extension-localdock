import * as fs from 'fs/promises';
import * as path from 'path';
import { SiteManifest } from '../models/Manifest';
import { logger } from '../utils/logger';

const MANIFEST_DIR = '.localwp';
const MANIFEST_FILE = 'manifest.json';

export function getManifestDir(localSitePath: string): string {
  return path.join(localSitePath, MANIFEST_DIR);
}

export function getManifestPath(localSitePath: string): string {
  return path.join(localSitePath, MANIFEST_DIR, MANIFEST_FILE);
}

export async function readManifest(
  localSitePath: string
): Promise<SiteManifest | null> {
  const manifestPath = getManifestPath(localSitePath);
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    return JSON.parse(raw) as SiteManifest;
  } catch {
    return null;
  }
}

export async function writeManifest(
  localSitePath: string,
  manifest: SiteManifest
): Promise<void> {
  const dir = getManifestDir(localSitePath);
  await fs.mkdir(dir, { recursive: true });
  const manifestPath = getManifestPath(localSitePath);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  logger.debug(`[Manifest] Written to ${manifestPath}`);
}
