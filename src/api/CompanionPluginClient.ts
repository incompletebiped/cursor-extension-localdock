import axios from 'axios';
import * as https from 'https';
import { SftpClient } from './SftpClient';
import { CompanionPluginStatus } from '../models/CompanionPlugin';
import { logger } from '../utils/logger';

const REST_ROUTE_PATH = '/wp-json/localdock/v1/changes';
const PLUGIN_FILE_RELATIVE_PATH = 'wp-content/plugins/localdock-companion/localdock-companion.php';
const PROBE_TIMEOUT_MS = 6000;

/**
 * Detects whether the LocalDock Companion plugin is installed and/or active on
 * a remote site. A REST probe alone can't distinguish "never installed" from
 * "installed but deactivated" — deactivating a plugin unregisters its REST
 * routes too, so both cases 404. The on-disk file check (via an already-open
 * SFTP session, when available) disambiguates the two.
 */
export async function detectCompanionPlugin(
  domain: string,
  docroot: string,
  sftp: SftpClient | undefined,
  rejectUnauthorizedSsl: boolean
): Promise<CompanionPluginStatus> {
  const routeRegistered = await probeRestRoute(domain, rejectUnauthorizedSsl);

  if (routeRegistered === true) {
    return 'active';
  }

  if (!sftp) {
    // No SSH session to check the filesystem — a 404 here is ambiguous
    // between "not installed" and "installed but deactivated".
    return 'unknown';
  }

  const installed = await fileExists(sftp, `${docroot}/${PLUGIN_FILE_RELATIVE_PATH}`);
  if (routeRegistered === false) {
    return installed ? 'inactive' : 'not_installed';
  }

  // Route probe itself failed (network/TLS error) — fall back to the file check alone.
  return installed ? 'inactive' : 'unknown';
}

/** Returns true if the REST route responds, false if it 404s, null if the request itself failed. */
async function probeRestRoute(domain: string, rejectUnauthorizedSsl: boolean): Promise<boolean | null> {
  try {
    const response = await axios.get(`https://${domain}${REST_ROUTE_PATH}`, {
      httpsAgent: new https.Agent({ rejectUnauthorized: rejectUnauthorizedSsl }),
      timeout: PROBE_TIMEOUT_MS,
      validateStatus: () => true,
    });
    return response.status !== 404;
  } catch (err) {
    logger.debug(`[CompanionPluginClient] REST probe failed for ${domain}: ${(err as Error).message}`);
    return null;
  }
}

async function fileExists(sftp: SftpClient, remotePath: string): Promise<boolean> {
  try {
    await sftp.stat(remotePath);
    return true;
  } catch {
    return false;
  }
}

export interface CompanionChangeRow {
  id: number;
  object_type: string;
  object_id: number | null;
  action: string;
  created_at: string;
}

export type CompanionChangesResult =
  | { ok: true; changes: CompanionChangeRow[]; serverTime: number; pluginVersion?: string }
  | { ok: false; reason: 'unauthorized' | 'not_found' | 'network' | 'unexpected'; status: number | null; message: string };

/**
 * Hits the companion plugin's read-only REST endpoint with the site's stored
 * API key. `sinceIso` should be the site's last-pulled timestamp (git-style
 * "what changed since origin's last known state") — omit it to get the most
 * recent rows regardless of when they happened.
 */
export async function fetchCompanionChanges(
  domain: string,
  apiKey: string,
  sinceIso: string | undefined,
  rejectUnauthorizedSsl: boolean
): Promise<CompanionChangesResult> {
  try {
    const params: Record<string, string> = {};
    if (sinceIso) {
      params.since = String(Math.floor(new Date(sinceIso).getTime() / 1000));
    }

    const response = await axios.get(`https://${domain}${REST_ROUTE_PATH}`, {
      headers: { 'X-LocalDock-Key': apiKey },
      params,
      httpsAgent: new https.Agent({ rejectUnauthorized: rejectUnauthorizedSsl }),
      timeout: PROBE_TIMEOUT_MS,
      validateStatus: () => true,
    });

    if (response.status === 200) {
      const data = response.data as {
        server_time?: number;
        plugin_version?: string;
        changes?: CompanionChangeRow[];
      };
      return {
        ok: true,
        changes: data.changes ?? [],
        serverTime: data.server_time ?? Date.now() / 1000,
        pluginVersion: data.plugin_version,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthorized', status: response.status, message: 'API key was rejected' };
    }
    if (response.status === 404) {
      return { ok: false, reason: 'not_found', status: 404, message: 'Companion plugin REST route not found' };
    }
    return { ok: false, reason: 'unexpected', status: response.status, message: `Unexpected HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, reason: 'network', status: null, message: (err as Error).message };
  }
}
