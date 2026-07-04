import * as vscode from 'vscode';
import { SiteTreeItem } from '../tree/SiteTreeItem';
import { SiteTreeProvider } from '../tree/SiteTreeProvider';
import { SiteRegistry } from '../SiteRegistry';
import { CredentialManager } from '../auth/CredentialManager';
import { ActivityManager } from '../ActivityManager';
import { ConfigManager } from '../utils/configManager';
import { SshClient } from '../api/SshClient';
import { connectPinned } from '../api/sshConnect';
import { SftpClient } from '../api/SftpClient';
import { WordPressSite } from '../models/Site';
import { provisionCompanionPlugin as runProvision } from '../companion/CompanionProvisioner';
import { fetchCompanionChanges } from '../api/CompanionPluginClient';
import { handleError } from '../utils/errors';
import { logger } from '../utils/logger';

async function promptForManualKey(
  site: WordPressSite,
  autoFetchMessage: string,
  configManager: ConfigManager
): Promise<string | undefined> {
  const choice = await vscode.window.showWarningMessage(autoFetchMessage, 'Enter API Key Manually');
  if (choice !== 'Enter API Key Manually') {
    return undefined;
  }

  const entered = await vscode.window.showInputBox({
    title: `LocalDock Companion API Key — ${site.domain}`,
    prompt: 'In wp-admin, go to Settings > LocalDock Companion on this site and copy the key shown there.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length < 20 ? 'That doesn\'t look like a valid key.' : undefined),
  });

  const trimmed = entered?.trim();
  if (!trimmed) {
    return undefined;
  }

  const check = await fetchCompanionChanges(site.domain, trimmed, undefined, configManager.rejectUnauthorizedSsl);
  if (!check.ok) {
    vscode.window.showErrorMessage(`That key was rejected by "${site.domain}": ${check.message}`);
    return undefined;
  }

  return trimmed;
}

export async function provisionCompanionPlugin(
  item: SiteTreeItem,
  registry: SiteRegistry,
  credManager: CredentialManager,
  siteTreeProvider: SiteTreeProvider,
  activityManager: ActivityManager,
  configManager: ConfigManager
): Promise<void> {
  const site = item.site;
  const server = registry.getServers().find((s) => s.id === site.serverId);
  if (!server) {
    vscode.window.showErrorMessage(`Server not found for "${site.domain}"`);
    return;
  }

  const creds = await credManager.get(site.serverId);
  if (!creds) {
    vscode.window.showErrorMessage(`No credentials for server "${server.host}"`);
    return;
  }

  const dbPass = await credManager.getDbPassword(site.id);
  if (!dbPass) {
    vscode.window.showErrorMessage(
      `No stored database password for "${site.domain}" — pull the site at least once first.`
    );
    return;
  }

  const { id: opId, token } = activityManager.start(site.domain, site.serverId, 'provision-companion');
  activityManager.update(opId, 10, 'Connecting to server…');

  const ssh = new SshClient();
  const sftp = new SftpClient();
  let apiKey: string | undefined;
  let activated = false;
  let message = '';

  try {
    await connectPinned(ssh, server, creds, registry);
    await sftp.open(ssh);

    if (token.isCancellationRequested) {
      activityManager.cancel(opId);
      return;
    }

    activityManager.update(opId, 30, 'Uploading Companion plugin files…');
    const result = await runProvision(site, dbPass, ssh, sftp);
    apiKey = result.apiKey;
    activated = result.activated;
    message = result.message;

    activityManager.complete(opId);
  } catch (err) {
    activityManager.fail(opId, err instanceof Error ? err.message : String(err));
    handleError('provisionCompanionPlugin', err);
    return;
  } finally {
    sftp.close();
    await ssh.disconnect();
  }

  // Never trust a key just because a row came back — the auto SQL lookup can
  // read the wrong options table (e.g. multisite, or a leftover duplicate
  // "*_options" table) and return a value that simply doesn't authenticate.
  // Confirm it actually works against the live site before storing it.
  if (apiKey) {
    const verify = await fetchCompanionChanges(site.domain, apiKey, undefined, configManager.rejectUnauthorizedSsl);
    if (!verify.ok) {
      logger.warn(`[provisionCompanionPlugin] Auto-fetched key for ${site.domain} did not validate: ${verify.message}`);
      message = `Companion plugin appears active on "${site.domain}", but the API key read from its database didn't authenticate — possibly a multisite install or a duplicate options table. Enter the key manually from Settings > LocalDock Companion instead.`;
      apiKey = undefined;
    }
  }

  // The automatic SSH+SQL key lookup can fail for reasons unrelated to whether
  // the plugin is actually working (mysql client not on PATH, unusual DB ACLs,
  // a wrong-table read caught above, etc.) — always give a manual way in
  // rather than leaving the user stuck.
  if (!apiKey) {
    apiKey = await promptForManualKey(site, message, configManager);
  }

  let updated: WordPressSite = { ...site };
  if (apiKey) {
    await credManager.storeCompanionKey(site.id, apiKey);
    updated = { ...updated, companionPlugin: 'active', companionKeyStatus: 'valid' };
  } else if (activated) {
    updated = { ...updated, companionPlugin: 'active', companionKeyStatus: 'not_provisioned' };
  } else {
    updated = { ...updated, companionPlugin: 'inactive', companionKeyStatus: 'not_provisioned' };
  }

  await registry.updateSite(updated);
  await siteTreeProvider.updateSiteState(updated);

  if (apiKey) {
    vscode.window.showInformationMessage(`LocalDock Companion is set up for "${site.domain}".`);
  } else if (!activated) {
    vscode.window.showInformationMessage(message);
  }
}
