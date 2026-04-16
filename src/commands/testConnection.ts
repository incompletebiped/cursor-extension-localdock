import * as vscode from 'vscode';
import { ServerTreeItem } from '../tree/ServerTreeProvider';
import { CredentialManager } from '../auth/CredentialManager';
import { AuthProvider } from '../auth/AuthProvider';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { logger } from '../utils/logger';

export async function testConnection(
  item: ServerTreeItem,
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
        const discover = await vscode.window.showInformationMessage(
          `Connected to ${server.host}! Discover WordPress sites now?`,
          'Discover Sites',
          'Later'
        );
        if (discover === 'Discover Sites') {
          siteTreeProvider.discoverForServer(server.id);
        }
        logger.info(`[testConnection] Success: ${server.host}:${server.sshPort}`);
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
