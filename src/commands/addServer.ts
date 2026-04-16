import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { SiteRegistry } from '../SiteRegistry';
import { CredentialManager } from '../auth/CredentialManager';
import { AuthProvider } from '../auth/AuthProvider';
import { ServerTreeProvider } from '../tree/ServerTreeProvider';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { ConfigManager } from '../utils/configManager';
import { CpanelServer } from '../models/Server';
import { handleError } from '../utils/errors';
import { CpanelClient } from '../api/CpanelClient';
import { normalizeHostname, promptCredentials, testConnectionWithFallback } from './serverHelpers';

export async function addServer(
  registry: SiteRegistry,
  credManager: CredentialManager,
  authProvider: AuthProvider,
  serverTreeProvider: ServerTreeProvider,
  siteTreeProvider: SiteTreeProvider,
  configManager: ConfigManager
): Promise<void> {
  try {
    const hostRaw = await vscode.window.showInputBox({
      title: 'Add cPanel Server (1/4)',
      prompt: 'Enter the server hostname or IP address',
      placeHolder: 'server.example.com  — or paste https://server.example.com:2083',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Hostname is required'),
    });
    if (hostRaw === undefined) { return; }
    const host = normalizeHostname(hostRaw);

    const username = await vscode.window.showInputBox({
      title: 'Add cPanel Server (2/4)',
      prompt: 'cPanel username',
      placeHolder: 'myusername',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Username is required'),
    });
    if (username === undefined) { return; }

    const sshPortStr = await vscode.window.showInputBox({
      title: 'Add cPanel Server (3/4)',
      prompt: 'SSH port (usually 22 or 2222)',
      value: String(configManager.sshPort),
      ignoreFocusOut: true,
      validateInput: (v) =>
        Number.isInteger(Number(v)) && Number(v) > 0 ? undefined : 'Enter a valid port number',
    });
    if (sshPortStr === undefined) { return; }

    const label = await vscode.window.showInputBox({
      title: 'Add cPanel Server (4/4)',
      prompt: 'Friendly name for this server (press Enter to use hostname)',
      placeHolder: host,
      ignoreFocusOut: true,
    });
    if (label === undefined) { return; }

    const creds = await promptCredentials(host, username.trim());
    if (!creds) { return; }

    const server: CpanelServer = {
      id: crypto.randomUUID(),
      label: label.trim() || host,
      host,
      cpanelUser: username.trim(),
      sshPort: Number(sshPortStr),
      cpanelPort: 2083,
      createdAt: new Date().toISOString(),
    };

    // Test cPanel HTTPS API first (no SSH required)
    let saved = false;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Connecting to ${host} via cPanel API…` },
      async () => {
        const cpanel = new CpanelClient(
          server,
          { ...creds, serverId: server.id },
          false // try without strict SSL first
        );
        const result = await cpanel.testApiConnection();
        if (result.success) {
          saved = true;
        } else {
          throw new Error(result.error ?? 'cPanel API connection failed');
        }
      }
    ).then(undefined, async (err: Error) => {
      const isAuth = err.message.toLowerCase().includes('invalid') ||
                     err.message.includes('401') || err.message.includes('403');
      const detail = isAuth
        ? `Wrong username or password.\n\nMake sure you're using your cPanel login credentials (not your email).`
        : `Could not reach cPanel at https://${host}:2083\n\n${err.message}`;

      const choice = await vscode.window.showWarningMessage(
        `cPanel connection failed — ${detail}`,
        { modal: true },
        'Save Anyway'
      );
      if (choice === 'Save Anyway') { saved = true; }
    });

    if (!saved) { return; }

    await credManager.store(server.id, creds);
    await registry.addServer(server);

    serverTreeProvider.refresh();
    siteTreeProvider.discoverForServer(server.id);

    vscode.window.showInformationMessage(
      `Server "${server.label}" added. Discovering WordPress sites…`
    );
  } catch (err) {
    handleError('addServer', err);
  }
}
