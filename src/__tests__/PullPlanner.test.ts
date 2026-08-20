import { describe, it, expect } from 'vitest';
import { planPull } from '../sync/PullPlanner';
import { DiffResult } from '../sync/DiffEngine';

function diff(partial: Partial<DiffResult>): DiffResult {
  return { added: [], modified: [], deleted: [], ...partial };
}

describe('planPull', () => {
  it('treats a server-only change as safe to download', () => {
    const plan = planPull(diff({ modified: ['wp-content/plugins/foo/foo.php'] }), diff({}));
    expect(plan.safeDownloads).toEqual(['wp-content/plugins/foo/foo.php']);
    expect(plan.conflicts).toEqual([]);
  });

  it('treats a server-only deletion as safe to delete locally', () => {
    const plan = planPull(diff({ deleted: ['wp-content/plugins/old/old.php'] }), diff({}));
    expect(plan.safeDeletes).toEqual(['wp-content/plugins/old/old.php']);
    expect(plan.conflicts).toEqual([]);
  });

  it('never touches a path the server did not change, regardless of local state', () => {
    // Local deleted a theme folder, but the server's copy is untouched (not in remoteDiff at all).
    const plan = planPull(diff({}), diff({ deleted: ['wp-content/themes/old-theme/style.css'] }));
    expect(plan.safeDownloads).toEqual([]);
    expect(plan.safeDeletes).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it('flags a path modified on both sides as a conflict', () => {
    const plan = planPull(
      diff({ modified: ['wp-content/themes/mytheme/functions.php'] }),
      diff({ modified: ['wp-content/themes/mytheme/functions.php'] })
    );
    expect(plan.safeDownloads).toEqual([]);
    expect(plan.conflicts).toEqual([
      { path: 'wp-content/themes/mytheme/functions.php', localStatus: 'modified', remoteStatus: 'modified' },
    ]);
  });

  it('flags a server deletion of a locally-modified file as a conflict instead of silently deleting it', () => {
    const plan = planPull(
      diff({ deleted: ['wp-content/plugins/foo/foo.php'] }),
      diff({ modified: ['wp-content/plugins/foo/foo.php'] })
    );
    expect(plan.safeDeletes).toEqual([]);
    expect(plan.conflicts).toEqual([
      { path: 'wp-content/plugins/foo/foo.php', localStatus: 'modified', remoteStatus: 'deleted' },
    ]);
  });

  it('treats an independent deletion on both sides as safe, not a conflict', () => {
    const plan = planPull(
      diff({ deleted: ['wp-content/plugins/gone/gone.php'] }),
      diff({ deleted: ['wp-content/plugins/gone/gone.php'] })
    );
    expect(plan.safeDeletes).toEqual(['wp-content/plugins/gone/gone.php']);
    expect(plan.conflicts).toEqual([]);
  });
});
