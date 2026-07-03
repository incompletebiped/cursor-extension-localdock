import { WordPressSite } from '../models/Site';

export type PullBucket = 'needed' | 'busy' | 'ready';

/**
 * Single source of truth for "has this site been pulled and is it safe to
 * start/interact with locally" — used both to gate the sidebar's inline
 * Pull/Start Local buttons and by startLocal's own precondition check, so
 * the button that's shown and the command that runs never disagree.
 */
export function getPullBucket(site: WordPressSite): PullBucket {
  const status = site.syncState.status;

  if (status === 'pulling' || status === 'pushing') {
    return 'busy';
  }

  if (!site.localPath || status === 'not_pulled' || status === 'unknown') {
    return 'needed';
  }

  return 'ready';
}

export function canStartLocalEnv(site: WordPressSite): boolean {
  return getPullBucket(site) === 'ready';
}
