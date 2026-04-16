import * as vscode from 'vscode';
import { WordPressSite } from '../models/Site';
import { SyncStatus } from '../models/SyncState';

// ServerTreeItem lives in ServerTreeProvider.ts — re-export for backwards compat
export { ServerTreeItem } from './ServerTreeProvider';

export class SiteTreeItem extends vscode.TreeItem {
  constructor(public readonly site: WordPressSite) {
    super(site.domain, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'wordpressSite';
    this.iconPath = iconForStatus(site.syncState.status);
    this.description = descriptionForStatus(site.syncState);
    this.tooltip = buildTooltip(site);
  }
}

export class LoadingTreeItem extends vscode.TreeItem {
  constructor() {
    super('Loading sites…', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('loading~spin');
  }
}

export class EmptyTreeItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

function iconForStatus(status: SyncStatus): vscode.ThemeIcon {
  switch (status) {
    case 'pulled':
      return new vscode.ThemeIcon(
        'check',
        new vscode.ThemeColor('charts.green')
      );
    case 'modified':
      return new vscode.ThemeIcon(
        'circle-filled',
        new vscode.ThemeColor('charts.yellow')
      );
    case 'pulling':
    case 'pushing':
      return new vscode.ThemeIcon('loading~spin');
    case 'error':
      return new vscode.ThemeIcon(
        'error',
        new vscode.ThemeColor('errorForeground')
      );
    case 'conflict':
      return new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('charts.orange')
      );
    default:
      return new vscode.ThemeIcon('globe');
  }
}

function descriptionForStatus(state: WordPressSite['syncState']): string {
  switch (state.status) {
    case 'pulling':
      return state.progress !== undefined
        ? `Pulling… ${state.progress}%`
        : 'Pulling…';
    case 'pushing':
      return state.progress !== undefined
        ? `Pushing… ${state.progress}%`
        : 'Pushing…';
    case 'modified':
      return state.localChanges !== undefined
        ? `${state.localChanges} change${state.localChanges !== 1 ? 's' : ''}`
        : 'Modified';
    case 'pulled':
      return state.lastPulledAt
        ? `Pulled ${formatRelativeTime(state.lastPulledAt)}`
        : 'Pulled';
    case 'error':
      return 'Error';
    case 'conflict':
      return 'Conflict';
    case 'not_pulled':
      return 'Not pulled';
    default:
      return '';
  }
}

function buildTooltip(site: WordPressSite): string {
  const lines = [
    `Domain: ${site.domain}`,
    `WP Version: ${site.wpVersion}`,
    `Database: ${site.dbName}`,
    `Docroot: ${site.docroot}`,
  ];
  if (site.localPath) {
    lines.push(`Local: ${site.localPath}`);
  }
  if (site.syncState.lastError) {
    lines.push(`Error: ${site.syncState.lastError}`);
  }
  return lines.join('\n');
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}
