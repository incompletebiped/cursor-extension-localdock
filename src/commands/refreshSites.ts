import { SiteTreeProvider } from '../tree/SiteTreeProvider';

export function refreshSites(treeProvider: SiteTreeProvider): void {
  treeProvider.refresh();
}
