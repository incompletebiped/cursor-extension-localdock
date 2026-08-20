import { describe, it, expect } from 'vitest';
import { mergeDatabasePullPlan } from '../sync/ChangelogPullPlanner';
import { ChangelogPushPlan } from '../sync/ChangelogPushPlanner';

function plan(partial: Partial<ChangelogPushPlan>): ChangelogPushPlan {
  return { optionNames: [], postIds: [], userIds: [], summary: '', isEmpty: true, ...partial };
}

describe('mergeDatabasePullPlan', () => {
  it('treats a server-only option change as safe to pull', () => {
    const result = mergeDatabasePullPlan(plan({ optionNames: ['active_plugins'] }), plan({}));
    expect(result.safeOptionNames).toEqual(['active_plugins']);
    expect(result.conflicts).toEqual([]);
    expect(result.isEmpty).toBe(false);
  });

  it('never surfaces a row the server did not change, even if local changed it', () => {
    const result = mergeDatabasePullPlan(plan({}), plan({ postIds: [85] }));
    expect(result.safePostIds).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.isEmpty).toBe(true);
  });

  it('flags an option changed on both sides as a conflict', () => {
    const result = mergeDatabasePullPlan(plan({ optionNames: ['template'] }), plan({ optionNames: ['template'] }));
    expect(result.safeOptionNames).toEqual([]);
    expect(result.conflicts).toEqual([{ kind: 'option', key: 'template' }]);
  });

  it('flags a post changed on both sides as a conflict, keyed by numeric id', () => {
    const result = mergeDatabasePullPlan(plan({ postIds: [85] }), plan({ postIds: [85] }));
    expect(result.safePostIds).toEqual([]);
    expect(result.conflicts).toEqual([{ kind: 'post', key: 85 }]);
  });

  it('handles independent changes to different posts without conflict', () => {
    const result = mergeDatabasePullPlan(plan({ postIds: [85, 90] }), plan({ postIds: [90, 91] }));
    expect(result.safePostIds).toEqual([85]);
    expect(result.conflicts).toEqual([{ kind: 'post', key: 90 }]);
  });
});
