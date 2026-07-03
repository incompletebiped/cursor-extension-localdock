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
import { normalizeHostname, promptCredentials, isCertError } from './serverHelpers';

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
        Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 65535 ? undefined : 'Enter a valid port number (1–65535)',
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

    // Test cPanel HTTPS API first (no SSH required). Try strict SSL; on a cert error
    // warn the user explicitly before retrying without SSL verification.
    let saved = false;
    let acceptInsecureSsl = false;

    const tryCpanelApi = async (strictSsl: boolean) => {
      const cpanel = new CpanelClient(server, { ...creds, serverId: server.id }, strictSsl);
      const result = await cpanel.testApiConnection();
      if (!result.success) {
        throw new Error(result.error ?? 'cPanel API connection failed');
      }
    };

    const handleApiFailure = async (err: Error) => {
      if (isCertError(err.message)) {
        const choice = await vscode.window.showWarningMessage(
          `SSL certificate error connecting to ${host}.\n\n` +
          `The certificate could not be verified — it may be self-signed or expired. ` +
          `Connecting without SSL verification is less secure.`,
          { modal: true },
          'Connect Without SSL Verification',
          'Save Anyway'
        );
        if (choice === 'Connect Without SSL Verification') {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Retrying ${host} without SSL verification…` },
            () => tryCpanelApi(false)
          ).then(
            () => { acceptInsecureSsl = true; saved = true; },
            async (retryErr: Error) => {
              const s = await vscode.window.showWarningMessage(
                `Still could not connect: ${retryErr.message}\n\nSave server anyway?`,
                { modal: true },
                'Save Anyway'
              );
              if (s === 'Save Anyway') { acceptInsecureSsl = true; saved = true; }
            }
          );
        } else if (choice === 'Save Anyway') {
          saved = true;
        }
        return;
      }

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
    };

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Connecting to ${host} via cPanel API…` },
      () => tryCpanelApi(true)
    ).then(() => { saved = true; }, handleApiFailure);

    if (!saved) { return; }

    if (acceptInsecureSsl) {
      server.rejectUnauthorizedSsl = false;
    }

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
