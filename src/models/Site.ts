import { SyncState } from './SyncState';
import { LocalEnvState } from './LocalEnvState';
import { CompanionPluginStatus, CompanionKeyStatus } from './CompanionPlugin';

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
  /** Whether the LocalDock Companion WP plugin was detected on the remote site. Undefined = not yet checked. */
  companionPlugin?: CompanionPluginStatus;
  /** Whether the API key stored in SecretStorage for this site still authenticates. Undefined = never provisioned. */
  companionKeyStatus?: CompanionKeyStatus;
  detectedAt: string;
}
