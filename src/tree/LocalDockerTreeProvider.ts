import * as vscode from 'vscode';
import { DockerManager } from '../docker/DockerManager';
import { SiteRegistry } from '../SiteRegistry';
import { ConfigManager } from '../utils/configManager';
import { LocalEnvStatus } from '../models/LocalEnvState';
import { WordPressSite } from '../models/Site';

// ---------------------------------------------------------------------------
// Tree item types
// ---------------------------------------------------------------------------

class DockerStatusItem extends vscode.TreeItem {
  constructor(version: string | null) {
    const label = version ? 'Docker Desktop' : 'Docker not installed';
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = version ? 'dockerInstalled' : 'dockerMissing';

    if (version) {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
      this.description = version;
      this.tooltip = `Docker ${version} is available`;
    } else {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      this.description = 'Click to install';
      this.tooltip = 'Docker Desktop is required for local WordPress environments.\nClick to open the download page.';
      this.command = {
        command: 'localwpCpanel.openDockerSetup',
        title: 'Install Docker Desktop',
      };
    }
  }
}

export class LocalEnvItem extends vscode.TreeItem {
  constructor(public readonly site: WordPressSite) {
    super(site.domain, vscode.TreeItemCollapsibleState.None);

    const localStatus = site.localEnv?.status ?? 'stopped';
    const isInitialized = !!site.localEnv?.port;

    this.contextValue = `localEnvItem localEnv_${localStatus}`;
    this.iconPath = iconForLocalStatus(localStatus, isInitialized);
    this.description = descriptionForLocalStatus(site);
    this.tooltip = buildLocalEnvTooltip(site);
  }
}

class SetupStepItem extends vscode.TreeItem {
  constructor(label: string, step: number) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'setupStep';
    this.iconPath = new vscode.ThemeIcon(
      step === 1 ? 'cloud-download' : step === 2 ? 'play' : 'browser'
    );
  }
}

class SectionHeaderItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'sectionHeader';
    this.description = '';
  }
}

class EmptyLocalItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'emptyLocal';
  }
}

type LocalDockerNode =
  | DockerStatusItem
  | LocalEnvItem
  | SetupStepItem
  | SectionHeaderItem
  | EmptyLocalItem;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class LocalDockerTreeProvider implements vscode.TreeDataProvider<LocalDockerNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<LocalDockerNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly dockerManager: DockerManager,
    private readonly registry: SiteRegistry,
    private readonly _configManager: ConfigManager
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: LocalDockerNode): vscode.TreeItem {
    return element;
  }

  async getChildren(_element?: LocalDockerNode): Promise<LocalDockerNode[]> {
    const nodes: LocalDockerNode[] = [];

    // Docker status
    const version = await this.dockerManager.getDockerVersion();
    nodes.push(new DockerStatusItem(version));

    // Pulled sites with local env
    const allSites = this.registry.getAllSites();
    const pulledSites = allSites.filter(s => s.localPath);

    if (pulledSites.length === 0) {
      nodes.push(new SectionHeaderItem('Local Environments'));
      nodes.push(new EmptyLocalItem('No sites pulled yet'));

      if (version) {
        nodes.push(new SectionHeaderItem('Getting Started'));
        nodes.push(new SetupStepItem('Step 1: Pull a site from cPanel', 1));
        nodes.push(new SetupStepItem('Step 2: Click "Start Local" on a pulled site', 2));
        nodes.push(new SetupStepItem('Step 3: Open site in Cursor Browser', 3));
      }
    } else {
      nodes.push(new SectionHeaderItem('Local Environments'));
      for (const site of pulledSites) {
        nodes.push(new LocalEnvItem(site));
      }
    }

    return nodes;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iconForLocalStatus(status: LocalEnvStatus, isInitialized: boolean): vscode.ThemeIcon {
  switch (status) {
    case 'running':
      return new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green'));
    case 'starting':
    case 'stopping':
      return new vscode.ThemeIcon('loading~spin');
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    case 'stopped':
      if (isInitialized) {
        return new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('disabledForeground'));
      }
      return new vscode.ThemeIcon('tools', new vscode.ThemeColor('charts.yellow'));
  }
}

function descriptionForLocalStatus(site: WordPressSite): string {
  const env = site.localEnv;
  if (!env) {
    return 'Not initialized';
  }
  switch (env.status) {
    case 'running':
      return env.port ? `▶ Running — http://localhost:${env.port}` : '▶ Running';
    case 'starting':
      return '↻ Starting…';
    case 'stopping':
      return '↻ Stopping…';
    case 'error':
      return `⚠ Error — ${env.lastError ?? 'unknown'}`;
    case 'stopped':
      return env.port ? '◼ Stopped' : 'Not initialized';
  }
}

function buildLocalEnvTooltip(site: WordPressSite): string {
  const lines = [`${site.domain}`];
  const env = site.localEnv;
  if (!env) {
    lines.push('Local environment not yet initialized.');
    lines.push('Click "Start Local" to set up.');
    return lines.join('\n');
  }
  const statusLabels: Record<LocalEnvStatus, string> = {
    stopped: '◼ Stopped',
    starting: '↻ Starting…',
    running: '▶ Running',
    stopping: '↻ Stopping…',
    error: '⚠ Error',
  };
  lines.push(`Status: ${statusLabels[env.status]}`);
  if (env.port) {
    lines.push(`Port: ${env.port}`);
  }
  if (env.url) {
    lines.push(`URL: ${env.url}`);
  }
  if (env.lastError) {
    lines.push(`Error: ${env.lastError}`);
  }
  if (site.localPath) {
    lines.push(`Local path: ${site.localPath}`);
  }
  return lines.join('\n');
}
