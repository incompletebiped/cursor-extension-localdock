import { CpanelServer } from '../models/Server';
import { ResolvedCredentials } from '../models/Credentials';
import { SshClient } from '../api/SshClient';
import { LocalDockError, LocalDockErrorCode } from '../utils/errors';
import { logger } from '../utils/logger';

export interface TestConnectionResult {
  success: boolean;
  error?: string;
  /** SHA256 fingerprint (hex) of the host key seen this attempt — set on both success and a host-key mismatch. */
  hostKeyFingerprint?: string;
  /** True if this failure was specifically a host-key mismatch, not an ordinary connection/auth failure. */
  hostKeyMismatch?: boolean;
}

export class AuthProvider {
  async testConnection(
    server: CpanelServer,
    creds: ResolvedCredentials
  ): Promise<TestConnectionResult> {
    const ssh = new SshClient();
    try {
      await ssh.connect(server, creds);
      const result = await ssh.exec('echo OK');
      if (result.stdout.trim() === 'OK') {
        logger.info(`[AuthProvider] Connection test succeeded for ${server.host}`);
        return { success: true, hostKeyFingerprint: ssh.observedHostKeyFingerprint };
      }
      return { success: false, error: 'Unexpected response from server' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[AuthProvider] Connection test failed for ${server.host}: ${message}`);
      const hostKeyMismatch = err instanceof LocalDockError && err.code === LocalDockErrorCode.HOST_KEY_MISMATCH;
      return {
        success: false,
        error: message,
        hostKeyFingerprint: ssh.observedHostKeyFingerprint,
        hostKeyMismatch,
      };
    } finally {
      await ssh.disconnect();
    }
  }
}
