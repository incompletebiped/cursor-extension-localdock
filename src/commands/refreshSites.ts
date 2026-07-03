import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { LocalDockerTreeProvider } from '../tree/LocalDockerTreeProvider';

/**
 * Re-discovers sites and reconciles their local state (folder still on disk,
 * Docker containers still up). Awaits discovery before refreshing Local
 * Environments so a site whose folder was deleted outside the extension
 * disappears from that view instead of lingering until the next reload.
 */
export async function refreshSites(
  treeProvider: SiteTreeProvider,
  localDockerTreeProvider: LocalDockerTreeProvider
): Promise<void> {
  await treeProvider.refresh();
  localDockerTreeProvider.refresh();
}
