import { SshClient } from './SshClient';
import { CpanelServer } from '../models/Server';
import { ResolvedCredentials } from '../models/Credentials';
import { SiteRegistry } from '../SiteRegistry';
import { logger } from '../utils/logger';

/**
 * Connects over SSH and, on a server's first-ever successful connection,
 * pins its host key fingerprint to the registry so later connections can
 * detect a changed key (SshClient.connect refuses to proceed if it doesn't
 * match). Use this instead of calling ssh.connect() directly anywhere the
 * caller already has a SiteRegistry — it's what makes the pinning durable.
 */
export async function connectPinned(
  ssh: SshClient,
  server: CpanelServer,
  creds: ResolvedCredentials,
  registry: SiteRegistry
): Promise<void> {
  await ssh.connect(server, creds);
  if (!server.hostKeyFingerprint && ssh.observedHostKeyFingerprint) {
    await registry.updateServer({ ...server, hostKeyFingerprint: ssh.observedHostKeyFingerprint });
    logger.info(`[SshClient] Pinned SSH host key for ${server.host}`);
  }
}
