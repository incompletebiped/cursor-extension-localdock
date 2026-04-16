export type SyncStatus =
  | 'unknown'
  | 'not_pulled'
  | 'pulling'
  | 'pushing'
  | 'pulled'
  | 'modified'
  | 'error'
  | 'conflict';

export interface SyncState {
  status: SyncStatus;
  progress?: number;
  message?: string;
  lastError?: string;
  lastPulledAt?: string;
  lastPushedAt?: string;
  localChanges?: number;
}
