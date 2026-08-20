import { DockerManager } from '../docker/DockerManager';
import { fetchCompanionChangesAt } from '../api/CompanionPluginClient';
import { logger } from '../utils/logger';

const LOCAL_DB_SERVICE = 'db';
const LOCAL_DB_NAME = 'wordpress';
const LOCAL_DB_USER = 'wordpress';
const LOCAL_DB_PASS = 'wordpress';

export interface ChangelogPushPlan {
  optionNames: string[];
  postIds: number[];
  userIds: number[];
  /** Human-readable summary for the push confirmation dialog, e.g. "2 option(s), 1 post(s) changed". */
  summary: string;
  isEmpty: boolean;
}

/**
 * Derives what actually changed in a database from a Companion plugin's
 * changelog since `sinceIso` — instead of assuming the whole database
 * changed. Works against any Companion instance (pass the local Docker site's
 * URL for push, or the remote site's URL for pull's conflict detection).
 * Returns null when that companion isn't reachable/provisioned, so the caller
 * can fall back to a full database dump.
 */
export async function planDatabasePush(
  companionBaseUrl: string,
  apiKey: string,
  sinceIso: string | undefined,
  rejectUnauthorizedSsl = false
): Promise<ChangelogPushPlan | null> {
  const result = await fetchCompanionChangesAt(companionBaseUrl, apiKey, sinceIso, rejectUnauthorizedSsl);
  if (!result.ok) {
    logger.info(`[ChangelogPushPlanner] Local Companion changelog unavailable (${result.reason}): ${result.message}`);
    return null;
  }

  const optionNames = new Set<string>();
  const postIds = new Set<number>();
  const userIds = new Set<number>();

  for (const row of result.changes) {
    switch (row.object_type) {
      case 'option': {
        const name = row.action.slice(row.action.indexOf(':') + 1);
        if (name) {
          optionNames.add(name);
        }
        break;
      }
      case 'post':
      case 'attachment':
        if (row.object_id !== null) {
          postIds.add(row.object_id);
        }
        break;
      case 'user':
        if (row.object_id !== null) {
          userIds.add(row.object_id);
        }
        break;
      default:
        break;
    }
  }

  const parts: string[] = [];
  if (optionNames.size > 0) {
    parts.push(`${optionNames.size} option(s)`);
  }
  if (postIds.size > 0) {
    parts.push(`${postIds.size} post(s)`);
  }
  if (userIds.size > 0) {
    parts.push(`${userIds.size} user(s)`);
  }

  return {
    optionNames: [...optionNames],
    postIds: [...postIds],
    userIds: [...userIds],
    summary: parts.length > 0 ? `${parts.join(', ')} changed` : 'no changes',
    isEmpty: optionNames.size === 0 && postIds.size === 0 && userIds.size === 0,
  };
}

/**
 * Builds a minimal SQL script covering exactly what `plan` says changed, by
 * reading the live local Docker database — the changelog only records *which*
 * rows changed, not their content. Rows are pulled via `mysqldump --where=...`
 * so their content is copied verbatim (no serialized-data rewriting, so no
 * byte-count corruption risk); rows that no longer exist locally are deleted
 * on the remote instead.
 */
export async function buildDatabasePushSql(
  localSitePath: string,
  dockerManager: DockerManager,
  plan: ChangelogPushPlan
): Promise<string> {
  const prefix = await detectLocalTablePrefix(localSitePath, dockerManager);
  const statements: string[] = [];

  if (plan.optionNames.length > 0) {
    statements.push(await buildOptionsSql(localSitePath, dockerManager, prefix, plan.optionNames));
  }

  if (plan.postIds.length > 0) {
    statements.push(
      await syncRowsByTable(localSitePath, dockerManager, `${prefix}posts`, `${prefix}postmeta`, 'post_id', 'ID', plan.postIds)
    );
  }

  if (plan.userIds.length > 0) {
    statements.push(
      await syncRowsByTable(localSitePath, dockerManager, `${prefix}users`, `${prefix}usermeta`, 'user_id', 'ID', plan.userIds)
    );
  }

  return statements.filter(Boolean).join('\n');
}

async function detectLocalTablePrefix(localSitePath: string, dockerManager: DockerManager): Promise<string> {
  const table = (
    await runDbCli(localSitePath, dockerManager, [
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE \'%\\_options\' LIMIT 1',
    ])
  ).trim();

  if (!/^[A-Za-z0-9_]+options$/.test(table)) {
    logger.warn(`[ChangelogPushPlanner] Could not resolve local table prefix (got "${table}") — assuming "wp_"`);
    return 'wp_';
  }
  return table.slice(0, -'options'.length);
}

async function buildOptionsSql(
  localSitePath: string,
  dockerManager: DockerManager,
  prefix: string,
  optionNames: string[]
): Promise<string> {
  const escaped = optionNames.map(escapeSqlString);
  const inList = escaped.map((n) => `'${n}'`).join(',');

  const raw = await runDbCli(localSitePath, dockerManager, [
    `SELECT option_name, HEX(option_value), autoload FROM ${prefix}options WHERE option_name IN (${inList})`,
  ]);

  const found = new Set<string>();
  const lines: string[] = [];

  for (const row of raw.split('\n')) {
    if (!row.trim()) {
      continue;
    }
    const [name, hexValue, autoload] = row.split('\t');
    if (!name) {
      continue;
    }
    found.add(name);
    lines.push(
      `INSERT INTO ${prefix}options (option_name, option_value, autoload) VALUES ('${escapeSqlString(name)}', UNHEX('${hexValue ?? ''}'), '${escapeSqlString(autoload ?? 'yes')}') ` +
        `ON DUPLICATE KEY UPDATE option_value=VALUES(option_value), autoload=VALUES(autoload);`
    );
  }

  for (const name of optionNames) {
    if (!found.has(name)) {
      lines.push(`DELETE FROM ${prefix}options WHERE option_name='${escapeSqlString(name)}';`);
    }
  }

  return lines.join('\n');
}

/**
 * Syncs a set of rows (by primary key) plus their associated meta table rows:
 * still-present rows are copied verbatim via mysqldump, rows no longer present
 * locally are deleted on the remote.
 */
async function syncRowsByTable(
  localSitePath: string,
  dockerManager: DockerManager,
  mainTable: string,
  metaTable: string,
  metaFkColumn: string,
  pkColumn: string,
  ids: number[]
): Promise<string> {
  const idList = ids.join(',');
  const existingRaw = await runDbCli(localSitePath, dockerManager, [
    `SELECT ${pkColumn} FROM ${mainTable} WHERE ${pkColumn} IN (${idList})`,
  ]);
  const existingIds = existingRaw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map(Number);
  const existingSet = new Set(existingIds);
  const missingIds = ids.filter((id) => !existingSet.has(id));

  const parts: string[] = [];

  if (missingIds.length > 0) {
    const missingList = missingIds.join(',');
    parts.push(`DELETE FROM ${metaTable} WHERE ${metaFkColumn} IN (${missingList});`);
    parts.push(`DELETE FROM ${mainTable} WHERE ${pkColumn} IN (${missingList});`);
  }

  if (existingIds.length > 0) {
    const existingList = existingIds.join(',');
    const mainDump = await runDbDump(localSitePath, dockerManager, mainTable, `${pkColumn} IN (${existingList})`);
    const metaDump = await runDbDump(localSitePath, dockerManager, metaTable, `${metaFkColumn} IN (${existingList})`);
    if (mainDump.trim()) {
      parts.push(mainDump);
    }
    if (metaDump.trim()) {
      parts.push(metaDump);
    }
  }

  return parts.join('\n');
}

async function runDbCli(localSitePath: string, dockerManager: DockerManager, statements: string[]): Promise<string> {
  const result = await dockerManager.execInService(localSitePath, LOCAL_DB_SERVICE, [
    'mysql', `-u${LOCAL_DB_USER}`, `-p${LOCAL_DB_PASS}`, '-N', '-B', LOCAL_DB_NAME, '-e', statements.join('; '),
  ]);
  if (result.code !== 0) {
    throw new Error(`Local database query failed: ${result.stderr.trim() || '(no stderr)'}`);
  }
  return result.stdout;
}

/**
 * Dumps just the rows matching `whereClause` from one table, with no
 * CREATE/DROP TABLE statements — the target table already exists on the
 * remote, and dropping it would wipe rows outside this push's scope.
 */
async function runDbDump(
  localSitePath: string,
  dockerManager: DockerManager,
  table: string,
  whereClause: string
): Promise<string> {
  const result = await dockerManager.execInService(localSitePath, LOCAL_DB_SERVICE, [
    'mysqldump',
    '--single-transaction',
    '--no-tablespaces',
    '--no-create-info',
    '--skip-add-locks',
    `-u${LOCAL_DB_USER}`,
    `-p${LOCAL_DB_PASS}`,
    `--where=${whereClause}`,
    LOCAL_DB_NAME,
    table,
  ]);
  if (result.code !== 0) {
    throw new Error(`Local mysqldump of ${table} failed: ${result.stderr.trim() || '(no stderr)'}`);
  }
  return result.stdout;
}

export function escapeSqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}
