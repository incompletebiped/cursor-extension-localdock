import { SyncState } from './SyncState';

export interface WordPressSite {
  id: string;
  serverId: string;
  domain: string;
  docroot: string;
  wpVersion: string;
  dbName: string;
  dbUser: string;
  dbHost: string;
  dbPass: string;
  localPath?: string;
  syncState: SyncState;
  detectedAt: string;
}
