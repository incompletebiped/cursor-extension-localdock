import * as vscode from 'vscode';
import { SiteRegistry } from '../SiteRegistry';
import { CpanelServer } from '../models/Server';

export class ServerTreeItem extends vscode.TreeItem {
  constructor(public readonly server: CpanelServer) {
    super(server.label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'cpanelServer';
    this.iconPath = new vscode.ThemeIcon('server');
    this.description = `${server.cpanelUser}@${server.host}`;
    this.tooltip = [
      `Host: ${server.host}`,
      `User: ${server.cpanelUser}`,
      `SSH port: ${server.sshPort}`,
      `cPanel port: ${server.cpanelPort}`,
      `Added: ${new Date(server.createdAt).toLocaleDateString()}`,
    ].join('\n');
  }
}

class EmptyServerItem extends vscode.TreeItem {
  constructor() {
    super('No servers. Click + to add one.', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

type ServerNode = ServerTreeItem | EmptyServerItem;

export class ServerTreeProvider implements vscode.TreeDataProvider<ServerNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly registry: SiteRegistry) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ServerNode): vscode.TreeItem {
    return element;
  }

  getChildren(_element?: ServerNode): ServerNode[] {
    const servers = this.registry.getServers();
    if (servers.length === 0) {
      return [new EmptyServerItem()];
    }
    return servers.map((s) => new ServerTreeItem(s));
  }
}
