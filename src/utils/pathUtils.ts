import * as path from 'path';

/** Ensure a remote path uses forward slashes (POSIX) */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Join remote path segments using forward slashes */
export function posixJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

/** Validate a string is safe to interpolate into a shell command as a DB/table name */
export function isValidDbIdentifier(name: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(name);
}

/**
 * Validate a string is safe to interpolate into a shell command as a DB host
 * (with an optional port). Accepts hostnames, IPv4, and bracketed IPv6 —
 * rejects anything else, since this value is read out of a site's
 * wp-config.php (DB_HOST) and must never reach a shell unescaped.
 */
export function isValidDbHost(host: string): boolean {
  if (/^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(host)) {
    return true;
  }
  return /^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(host);
}

/** Sanitize a domain name into a valid local MySQL database name */
export function sanitizeDbName(domain: string): string {
  return domain.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
}

/** Check for path traversal attempts */
export function isSafePath(p: string): boolean {
  const normalized = path.normalize(p);
  return !normalized.includes('..') && !path.isAbsolute(normalized);
}
