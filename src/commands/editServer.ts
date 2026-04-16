import * as vscode from 'vscode';
import { SiteRegistry } from '../SiteRegistry';
import { CredentialManager } from '../auth/CredentialManager';
import { ServerTreeProvider, ServerTreeItem } from '../tree/ServerTreeProvider';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { CpanelClient } from '../api/CpanelClient';
import { handleError } from '../utils/errors';
import { normalizeHostname, promptCredentials } from './serverHelpers';

export async function editServer(
  item: ServerTreeItem,
  registry: SiteRegistry,
  credManager: CredentialManager,
  serverTreeProvider: ServerTreeProvider,
  siteTreeProvider: SiteTreeProvider
): Promise<void> {
  const existing = item.server;

  try {
    // --- Hostname (pre-filled) ---
    const hostRaw = await vscode.window.showInputBox({
      title: `Edit Server: ${existing.label} (1/4)`,
      prompt: 'Server hostname or IP address',
      value: existing.host,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Hostname is required'),
    });
    if (hostRaw === undefined) { return; }
    const host = normalizeHostname(hostRaw);

    // --- Username (pre-filled) ---
    const username = await vscode.window.showInputBox({
      title: `Edit Server: ${existing.label} (2/4)`,
      prompt: 'cPanel username',
      value: existing.cpanelUser,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Username is required'),
    });
    if (username === undefined) { return; }

    // --- SSH port (pre-filled) ---
    const sshPortStr = await vscode.window.showInputBox({
      title: `Edit Server: ${existing.label} (3/4)`,
      prompt: 'SSH port',
      value: String(existing.sshPort),
      ignoreFocusOut: true,
      validateInput: (v) =>
        Number.isInteger(Number(v)) && Number(v) > 0 ? undefined : 'Enter a valid port number',
    });
    if (sshPortStr === undefined) { return; }

    // --- Display name (pre-filled) ---
    const label = await vscode.window.showInputBox({
      title: `Edit Server: ${existing.label} (4/4)`,
      prompt: 'Display name',
      value: existing.label,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Display name is required'),
    });
    if (label === undefined) { return; }

    // --- Credentials: keep existing or replace ---
    const existingCreds = await credManager.get(existing.id);
    const changeCredsChoice = await vscode.window.showQuickPick(
      [
        {
          label: '$(check) Keep existing credentials',
          description: existingCreds ? `Currently using ${existingCreds.type}` : 'No credentials saved',
          id: 'keep',
        },
        {
          label: '$(key) Change credentials',
          description: 'Enter a new password or SSH key',
          id: 'change',
        },
      ],
      {
        title: 'Credentials',
        ignoreFocusOut: true,
      }
    );
    if (!changeCredsChoice) { return; }

    let creds = existingCreds;

    if (changeCredsChoice.id === 'change') {
      const newCreds = await promptCredentials(
        host,
        username.trim(),
        existingCreds?.type
      );
      if (!newCreds) { return; }
      creds = { ...newCreds, serverId: existing.id };
    }

    if (!creds) {
      vscode.window.showErrorMessage('No credentials available. Please add credentials.');
      return;
    }

    // Build updated server object (keep same ID and createdAt)
    const updated = {
      ...existing,
      host,
      cpanelUser: username.trim(),
      sshPort: Number(sshPortStr),
      label: label.trim(),
    };

    // Test cPanel HTTPS API with updated settings
    let ok = false;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing connection to ${updated.host}…` },
      async () => {
        const cpanel = new CpanelClient(updated, { ...creds, serverId: updated.id }, false);
        const result = await cpanel.testApiConnection();
        if (result.success) {
          ok = true;
        } else {
          throw new Error(result.error ?? 'Connection failed');
        }
      }
    ).then(undefined, async (err: Error) => {
      const choice = await vscode.window.showWarningMessage(
        `Connection test failed: ${err.message}\n\nSave changes anyway?`,
        { modal: true },
        'Save Anyway'
      );
      if (choice === 'Save Anyway') { ok = true; }
    });

    if (!ok) { return; }

    // Save updated credentials if changed
    if (changeCredsChoice.id === 'change') {
      await credManager.store(existing.id, creds);
    }
    await registry.updateServer(updated);

    serverTreeProvider.refresh();
    // Re-discover sites with updated connection details
    siteTreeProvider.discoverForServer(existing.id);

    vscode.window.showInformationMessage(`Server "${updated.label}" updated.`);
  } catch (err) {
    handleError('editServer', err);
  }
}
