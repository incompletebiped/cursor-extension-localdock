import * as vscode from 'vscode';
import { ActivityManager, Operation } from '../ActivityManager';

class RunningItem extends vscode.TreeItem {
  constructor(public readonly op: Operation) {
    super(op.domain, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'runningOperation';
    this.iconPath = new vscode.ThemeIcon('loading~spin');
    const typeLabel = { pull: '↓ Pull', push: '↑ Push', 'start-local': '▶ Start Local', 'stop-local': '■ Stop Local' }[op.type] ?? op.type;
    this.description = `${typeLabel} ${op.progress}% — ${op.message}`;
    this.tooltip = [
      `${typeLabel} ${op.domain}`,
      `Progress: ${op.progress}%`,
      `Status: ${op.message}`,
      `Started: ${op.startedAt.toLocaleTimeString()}`,
    ].join('\n');
  }
}

class HistoryItem extends vscode.TreeItem {
  constructor(public readonly op: Operation) {
    super(op.domain, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'completedOperation';

    const typeLabel = { pull: '↓ Pull', push: '↑ Push', 'start-local': '▶ Start Local', 'stop-local': '■ Stop Local' }[op.type] ?? op.type;
    const duration = op.finishedAt
      ? Math.round((op.finishedAt.getTime() - op.startedAt.getTime()) / 1000)
      : 0;

    switch (op.status) {
      case 'completed':
        this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
        this.description = `${typeLabel} — ${duration}s`;
        break;
      case 'failed':
        this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        this.description = `${typeLabel} failed — ${op.error ?? 'unknown error'}`;
        break;
      case 'cancelled':
        this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
        this.description = `${typeLabel} cancelled`;
        break;
    }

    this.tooltip = [
      `${op.domain}`,
      `Operation: ${op.type}`,
      `Status: ${op.status}`,
      op.error ? `Error: ${op.error}` : '',
      `Started: ${op.startedAt.toLocaleTimeString()}`,
      op.finishedAt ? `Finished: ${op.finishedAt.toLocaleTimeString()} (${duration}s)` : '',
    ].filter(Boolean).join('\n');
  }
}

class SectionHeader extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'sectionHeader';
  }
}

class EmptyItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'emptyActivity';
  }
}

type ActivityNode = RunningItem | HistoryItem | SectionHeader | EmptyItem;

export class ActivityTreeProvider implements vscode.TreeDataProvider<ActivityNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ActivityNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly manager: ActivityManager) {
    manager.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(element: ActivityNode): vscode.TreeItem {
    return element;
  }

  getChildren(_element?: ActivityNode): ActivityNode[] {
    const running = this.manager.getRunning();
    const history = this.manager.getHistory();
    const nodes: ActivityNode[] = [];

    if (running.length === 0 && history.length === 0) {
      return [new EmptyItem('No activity yet.')];
    }

    if (running.length > 0) {
      nodes.push(...running.map(op => new RunningItem(op)));
    }

    if (history.length > 0) {
      nodes.push(...history.map(op => new HistoryItem(op)));
    }

    return nodes;
  }

  /** Expose the operation ID from a tree item for the cancel command */
  getOperationId(item: ActivityNode): string | undefined {
    if (item instanceof RunningItem) {
      return item.op.id;
    }
    return undefined;
  }
}
