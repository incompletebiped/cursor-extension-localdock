import { CpanelServer } from '../models/Server';
import { ResolvedCredentials } from '../models/Credentials';
import { SshClient } from '../api/SshClient';
import { logger } from '../utils/logger';

export class AuthProvider {
  async testConnection(
    server: CpanelServer,
    creds: ResolvedCredentials
  ): Promise<{ success: boolean; error?: string }> {
    const ssh = new SshClient();
    try {
      await ssh.connect(server, creds);
      const result = await ssh.exec('echo OK');
      if (result.stdout.trim() === 'OK') {
        logger.info(`[AuthProvider] Connection test succeeded for ${server.host}`);
        return { success: true };
      }
      return { success: false, error: 'Unexpected response from server' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[AuthProvider] Connection test failed for ${server.host}: ${message}`);
      return { success: false, error: message };
    } finally {
      await ssh.disconnect();
    }
  }
}
