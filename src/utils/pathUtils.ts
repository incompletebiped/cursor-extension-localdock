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

/** Sanitize a domain name into a valid local MySQL database name */
export function sanitizeDbName(domain: string): string {
  return domain.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
}

/** Check for path traversal attempts */
export function isSafePath(p: string): boolean {
  const normalized = path.normalize(p);
  return !normalized.includes('..') && !path.isAbsolute(normalized);
}
