import * as vscode from 'vscode';
import { CpanelServer } from '../models/Server';
import { StoredCredentials } from '../models/Credentials';
import { AuthProvider } from '../auth/AuthProvider';

/** Strip protocol, port suffix, and trailing path so users can paste full cPanel URLs */
export function normalizeHostname(input: string): string {
  let h = input.trim();
  h = h.replace(/^https?:\/\//i, '');
  h = h.split('/')[0];
  h = h.replace(/:\d+$/, '');
  return h.trim();
}

/** Return true if an error message indicates an SSL/TLS certificate failure. */
export function isCertError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('certificate') ||
    lower.includes('self signed') ||
    lower.includes('self-signed') ||
    lower.includes('unable to verify') ||
    lower.includes('err_tls') ||
    lower.includes('depth_zero') ||
    lower.includes('eproto')
  );
}

/** Return true if string looks like a PEM private key */
export function looksLikePrivateKey(content: string): boolean {
  return (
    content.includes('-----BEGIN') &&
    (content.includes('PRIVATE KEY') || content.includes('OPENSSH PRIVATE KEY'))
  );
}

/**
 * Test SSH connection, offering port-2222 retry and "Save Anyway" on failure.
 * Mutates server.sshPort if the user retries on 2222.
 * Returns true if the caller should proceed with saving.
 */
export async function testConnectionWithFallback(
  server: CpanelServer,
  creds: StoredCredentials,
  authProvider: AuthProvider
): Promise<boolean> {
  const tryConnect = async (s: CpanelServer): Promise<boolean> => {
    const result = await authProvider.testConnection(s, { ...creds, serverId: s.id });
    return result.success;
  };

  let connectionOk = false;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Testing SSH connection to ${server.host}:${server.sshPort}…`,
    },
    async () => {
      const ok = await tryConnect(server);
      if (ok) {
        connectionOk = true;
      } else {
        throw new Error(`Could not connect on port ${server.sshPort}`);
      }
    }
  ).then(undefined, async (err: Error) => {
    const isRefused = err.message.includes('ECONNREFUSED');
    const isTimeout = err.message.includes('ETIMEDOUT') || err.message.includes('ECONNRESET');

    let detail: string;
    let hint: string;

    if (isRefused) {
      detail = `Connection refused on ${server.host}:${server.sshPort}.`;
      hint =
        `This usually means:\n` +
        `• The server firewall (CSF) is blocking your IP address\n` +
        `• Your local network is blocking outbound SSH\n\n` +
        `To fix: log into cPanel → Security → SSH Access and whitelist your IP, ` +
        `or ask your host to allowlist it. The cPanel web terminal uses an internal ` +
        `connection and does not prove port ${server.sshPort} is open externally.`;
    } else if (isTimeout) {
      detail = `Connection timed out reaching ${server.host}:${server.sshPort}.`;
      hint =
        `The server is not responding. Possible causes:\n` +
        `• Wrong hostname or IP\n` +
        `• Firewall silently dropping packets\n` +
        `• Network connectivity issue`;
    } else {
      detail = err.message;
      hint = `Check the Output panel (LocalDock cPanel) for full details.`;
    }

    const buttons: string[] = ['Save Anyway', 'Skip & Save'];
    if (isRefused && server.sshPort !== 2222) {
      buttons.unshift('Try Port 2222');
    }

    const choice = await vscode.window.showWarningMessage(
      `SSH connection failed — ${detail}\n\n${hint}`,
      { modal: true },
      ...buttons
    );

    if (choice === 'Try Port 2222') {
      server.sshPort = 2222;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Retrying on ${server.host}:2222…` },
        async () => {
          const ok = await tryConnect(server);
          if (ok) {
            connectionOk = true;
          } else {
            const retry = await vscode.window.showWarningMessage(
              `Still could not connect on port 2222.\n\nSave the server anyway? You can right-click it later to test the connection once your IP is whitelisted.`,
              { modal: true },
              'Save Anyway'
            );
            if (retry === 'Save Anyway') { connectionOk = true; }
          }
        }
      );
    } else if (choice === 'Save Anyway' || choice === 'Skip & Save') {
      connectionOk = true;
    }
  });

  return connectionOk;
}

/** Prompt for SSH credentials (password or key file). Returns undefined if cancelled. */
export async function promptCredentials(
  host: string,
  username: string,
  existingType?: 'password' | 'key'
): Promise<StoredCredentials | undefined> {
  const items = [
    { label: '$(key) Password', description: 'SSH / cPanel password', id: 'password' },
    { label: '$(file) SSH Key', description: 'Private key file (.pem, id_rsa, etc.)', id: 'key' },
  ];

  // Pre-select the existing auth type if editing
  const authType = await vscode.window.showQuickPick(items, {
    title: 'Authentication method',
    placeHolder: existingType
      ? `Currently using ${existingType} — pick to change, or press Escape to keep existing`
      : 'Choose authentication method',
    ignoreFocusOut: true,
  });
  if (!authType) {
    return undefined;
  }

  if (authType.id === 'password') {
    const password = await vscode.window.showInputBox({
      title: 'SSH Password',
      prompt: `Password for ${username}@${host}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v ? undefined : 'Password cannot be empty'),
    });
    if (password === undefined) {
      return undefined;
    }
    return { type: 'password', password };
  } else {
    const keyFiles = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select SSH private key',
      title: 'Select your SSH private key file (NOT the .pub file)',
      filters: { 'Private key files': ['pem', 'key', ''], 'All files': ['*'] },
    });
    if (!keyFiles || keyFiles.length === 0) {
      return undefined;
    }

    const fs = await import('fs/promises');
    const privateKey = await fs.readFile(keyFiles[0].fsPath, 'utf8');

    if (!looksLikePrivateKey(privateKey)) {
      vscode.window.showErrorMessage(
        'That file does not look like a private key. Select the key file (e.g. id_rsa), not the .pub file.'
      );
      return undefined;
    }

    const passphrase = await vscode.window.showInputBox({
      title: 'SSH Key Passphrase',
      prompt: 'Key passphrase (press Enter to skip if none)',
      password: true,
      ignoreFocusOut: true,
    });
    if (passphrase === undefined) {
      return undefined;
    }
    return { type: 'key', privateKey, passphrase: passphrase || undefined };
  }
}
