export type LocalEnvStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface LocalEnvState {
  status: LocalEnvStatus;
  port?: number;
  url?: string;
  lastError?: string;
}
