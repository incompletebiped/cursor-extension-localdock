import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { fetchCompanionChangesAtMock } = vi.hoisted(() => ({ fetchCompanionChangesAtMock: vi.fn() }));
vi.mock('../api/CompanionPluginClient', () => ({
  fetchCompanionChangesAt: fetchCompanionChangesAtMock,
}));

import { planDatabasePush } from '../sync/ChangelogPushPlanner';

function change(object_type: string, object_id: number | null, action: string) {
  return { id: 1, object_type, object_id, action, created_at: '2026-01-01 00:00:00' };
}

describe('planDatabasePush', () => {
  it('returns null when the changelog request fails', async () => {
    fetchCompanionChangesAtMock.mockResolvedValueOnce({ ok: false, reason: 'not_found', status: 404, message: 'nope' });
    const plan = await planDatabasePush('http://localhost:8080', 'key', undefined);
    expect(plan).toBeNull();
  });

  it('reports an empty plan when there are no changes', async () => {
    fetchCompanionChangesAtMock.mockResolvedValueOnce({ ok: true, changes: [], serverTime: 0 });
    const plan = await planDatabasePush('http://localhost:8080', 'key', undefined);
    expect(plan).not.toBeNull();
    expect(plan!.isEmpty).toBe(true);
    expect(plan!.summary).toBe('no changes');
  });

  it('extracts distinct option names from added/updated/deleted rows', async () => {
    fetchCompanionChangesAtMock.mockResolvedValueOnce({
      ok: true,
      serverTime: 0,
      changes: [
        change('option', null, 'updated:template'),
        change('option', null, 'updated:stylesheet'),
        change('option', null, 'updated:template'),
        change('option', null, 'added:my_new_setting'),
        change('option', null, 'deleted:old_setting'),
      ],
    });
    const plan = await planDatabasePush('http://localhost:8080', 'key', undefined);
    expect(plan!.isEmpty).toBe(false);
    expect(new Set(plan!.optionNames)).toEqual(new Set(['template', 'stylesheet', 'my_new_setting', 'old_setting']));
    expect(plan!.summary).toBe('4 option(s) changed');
  });

  it('collects post and attachment ids into one set, and user ids separately', async () => {
    fetchCompanionChangesAtMock.mockResolvedValueOnce({
      ok: true,
      serverTime: 0,
      changes: [
        change('post', 12, 'updated'),
        change('post', 12, 'updated'),
        change('attachment', 34, 'created'),
        change('user', 7, 'updated'),
      ],
    });
    const plan = await planDatabasePush('http://localhost:8080', 'key', undefined);
    expect(new Set(plan!.postIds)).toEqual(new Set([12, 34]));
    expect(plan!.userIds).toEqual([7]);
    expect(plan!.summary).toBe('2 post(s), 1 user(s) changed');
  });

  it('ignores rows with a null object_id for post/user types', async () => {
    fetchCompanionChangesAtMock.mockResolvedValueOnce({
      ok: true,
      serverTime: 0,
      changes: [change('post', null, 'updated')],
    });
    const plan = await planDatabasePush('http://localhost:8080', 'key', undefined);
    expect(plan!.postIds).toEqual([]);
    expect(plan!.isEmpty).toBe(true);
  });
});
