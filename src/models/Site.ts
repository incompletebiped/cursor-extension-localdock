import { SyncState } from './SyncState';
import { LocalEnvState } from './LocalEnvState';

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
  localEnv?: LocalEnvState;
  detectedAt: string;
}
