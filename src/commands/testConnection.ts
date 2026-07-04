import * as vscode from 'vscode';
import { ServerTreeItem } from '../tree/ServerTreeProvider';
import { SiteRegistry } from '../SiteRegistry';
import { CredentialManager } from '../auth/CredentialManager';
import { AuthProvider } from '../auth/AuthProvider';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { logger } from '../utils/logger';

export async function testConnection(
  item: ServerTreeItem,
  registry: SiteRegistry,
  credManager: CredentialManager,
  authProvider: AuthProvider,
  siteTreeProvider: SiteTreeProvider
): Promise<void> {
  const server = item.server;

  const creds = await credManager.get(server.id);
  if (!creds) {
    vscode.window.showErrorMessage(`No credentials saved for "${server.label}". Edit the server to add credentials.`);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Testing SSH connection to ${server.host}:${server.sshPort}…`,
      cancellable: false,
    },
    async () => {
      const result = await authProvider.testConnection(server, { ...creds, serverId: server.id });

      if (result.success) {
        // First-ever successful connection to this server — pin the host key so
        // later connections can detect if it ever changes.
        if (!server.hostKeyFingerprint && result.hostKeyFingerprint) {
          await registry.updateServer({ ...server, hostKeyFingerprint: result.hostKeyFingerprint });
          logger.info(`[testConnection] Pinned SSH host key for ${server.host}`);
        }

        const discover = await vscode.window.showInformationMessage(
          `Connected to ${server.host}! Discover WordPress sites now?`,
          'Discover Sites',
          'Later'
        );
        if (discover === 'Discover Sites') {
          siteTreeProvider.discoverForServer(server.id);
        }
        logger.info(`[testConnection] Success: ${server.host}:${server.sshPort}`);
      } else if (result.hostKeyMismatch) {
        logger.warn(`[testConnection] Host key mismatch: ${server.host} — ${result.error}`);
        const choice = await vscode.window.showWarningMessage(
          `${result.error}`,
          { modal: true },
          'Trust New Key & Retry',
          'Cancel'
        );
        if (choice === 'Trust New Key & Retry' && result.hostKeyFingerprint) {
          const updated = { ...server, hostKeyFingerprint: result.hostKeyFingerprint };
          await registry.updateServer(updated);
          const retry = await authProvider.testConnection(updated, { ...creds, serverId: server.id });
          if (retry.success) {
            vscode.window.showInformationMessage(`New host key trusted — connected to ${server.host}.`);
            logger.info(`[testConnection] New host key trusted and connection succeeded: ${server.host}`);
          } else {
            vscode.window.showErrorMessage(`Still could not connect to ${server.host}: ${retry.error ?? 'unknown error'}`);
          }
        }
      } else {
        const isRefused = (result.error ?? '').includes('ECONNREFUSED');
        const hint = isRefused
          ? `\n\nMost likely cause: the server firewall is blocking your IP. ` +
            `Log into cPanel → Security → SSH Access and whitelist your current IP address, then try again.`
          : '';

        vscode.window.showErrorMessage(
          `Could not connect to ${server.host}:${server.sshPort} — ${result.error ?? 'unknown error'}${hint}`
        );
        logger.warn(`[testConnection] Failed: ${server.host} — ${result.error}`);
      }
    }
  );
}
