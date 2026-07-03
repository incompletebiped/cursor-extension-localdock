import * as vscode from 'vscode';
import * as crypto from 'crypto';

export type OperationType = 'pull' | 'push' | 'start-local' | 'stop-local' | 'check-remote' | 'provision-companion';
export type OperationStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface Operation {
  id: string;
  domain: string;
  serverId: string;
  type: OperationType;
  status: OperationStatus;
  progress: number;       // 0–100
  message: string;
  startedAt: Date;
  finishedAt?: Date;
  error?: string;
}

export class ActivityManager {
  private running = new Map<string, { op: Operation; tokenSource: vscode.CancellationTokenSource }>();
  private history: Operation[] = [];
  private readonly MAX_HISTORY = 20;
  // Per-operation throttle for progress refresh events. With high SFTP
  // concurrency, dozens of files can complete within the same tick, each
  // calling update() — without this, that fires a tree refresh per file,
  // which VS Code coalesces unpredictably and makes the % jump erratically.
  private lastUpdateEmit = new Map<string, number>();
  private static readonly UPDATE_THROTTLE_MS = 150;

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /** Start a new operation. Returns { id, token } — pass token to pull/push internals. */
  start(domain: string, serverId: string, type: OperationType): { id: string; token: vscode.CancellationToken } {
    const id = crypto.randomUUID();
    const tokenSource = new vscode.CancellationTokenSource();
    const op: Operation = {
      id, domain, serverId, type,
      status: 'running',
      progress: 0,
      message: type === 'pull' ? 'Starting pull…' : type === 'push' ? 'Starting push…' : type === 'start-local' ? 'Starting local environment…' : type === 'stop-local' ? 'Stopping local environment…' : 'Checking remote…',
      startedAt: new Date(),
    };
    this.running.set(id, { op, tokenSource });
    this._onDidChange.fire();
    return { id, token: tokenSource.token };
  }

  update(id: string, progress: number, message: string): void {
    const entry = this.running.get(id);
    if (!entry) { return; }
    entry.op.progress = progress;
    entry.op.message = message;

    // State above is always current; only the UI refresh is throttled, so the
    // next tick (ours or another operation's) always shows the latest values.
    const now = Date.now();
    const lastEmit = this.lastUpdateEmit.get(id) ?? 0;
    if (now - lastEmit < ActivityManager.UPDATE_THROTTLE_MS) {
      return;
    }
    this.lastUpdateEmit.set(id, now);
    this._onDidChange.fire();
  }

  complete(id: string): void {
    this.finish(id, 'completed');
  }

  fail(id: string, error: string): void {
    const entry = this.running.get(id);
    if (entry) { entry.op.error = error; }
    this.finish(id, 'failed');
  }

  cancel(id: string): void {
    const entry = this.running.get(id);
    if (!entry) { return; }
    entry.tokenSource.cancel();
    this.finish(id, 'cancelled');
  }

  cancelAll(): void {
    for (const id of this.running.keys()) {
      this.cancel(id);
    }
  }

  getRunning(): Operation[] {
    return [...this.running.values()].map(e => e.op);
  }

  getHistory(): Operation[] {
    return [...this.history];
  }

  hasRunning(): boolean {
    return this.running.size > 0;
  }

  private finish(id: string, status: OperationStatus): void {
    const entry = this.running.get(id);
    if (!entry) { return; }
    entry.op.status = status;
    entry.op.finishedAt = new Date();
    entry.op.progress = status === 'completed' ? 100 : entry.op.progress;
    entry.tokenSource.dispose();
    this.running.delete(id);
    this.lastUpdateEmit.delete(id);
    this.history.unshift(entry.op);
    if (this.history.length > this.MAX_HISTORY) {
      this.history.length = this.MAX_HISTORY;
    }
    this._onDidChange.fire();
  }
}
