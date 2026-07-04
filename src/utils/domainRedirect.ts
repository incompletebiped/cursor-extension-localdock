import axios from 'axios';
import * as https from 'https';
import { logger } from './logger';

const PROBE_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 5;

/**
 * Resolve the host a domain actually lands on after following HTTP redirects.
 * Used to tell a real site apart from an email/redirect-only domain that points
 * at another site's docroot: the redirect domain lands on a *different* host.
 *
 * Returns the final host (e.g. `www.example.com`), or null if the probe was
 * inconclusive (network/TLS failure, DNS error) — callers should treat null as
 * "unknown" and fail open rather than hide a site.
 */
export async function resolveEffectiveHost(
  domain: string,
  rejectUnauthorizedSsl: boolean
): Promise<string | null> {
  // Try HTTPS first, then fall back to HTTP — an email/redirect domain may not
  // have a valid certificate but still issue its redirect over plain HTTP.
  for (const scheme of ['https', 'http'] as const) {
    try {
      const response = await axios.request({
        method: 'GET',
        url: `${scheme}://${domain}/`,
        httpsAgent: new https.Agent({ rejectUnauthorized: rejectUnauthorizedSsl }),
        timeout: PROBE_TIMEOUT_MS,
        maxRedirects: MAX_REDIRECTS,
        validateStatus: () => true,
      });

      // Node's http adapter exposes the final URL (after redirects) here.
      const finalUrl: string | undefined =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (response.request as any)?.res?.responseUrl ?? (response.request as any)?.responseURL;

      const host = finalUrl ? new URL(finalUrl).host : domain;
      logger.debug(`[domainRedirect] ${domain} (${scheme}) resolved to host ${host}`);
      return host;
    } catch (err) {
      logger.debug(`[domainRedirect] ${scheme} probe failed for ${domain}: ${(err as Error).message}`);
    }
  }
  return null;
}
