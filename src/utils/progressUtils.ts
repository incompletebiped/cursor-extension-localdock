import * as vscode from 'vscode';

export interface ProgressTask<T> {
  title: string;
  cancellable?: boolean;
  run: (
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ) => Promise<T>;
}

export function withProgress<T>(task: ProgressTask<T>): Thenable<T> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: task.title,
      cancellable: task.cancellable ?? false,
    },
    task.run
  );
}

/**
 * Build a vscode.Progress-compatible adapter that maps "(done / total)" messages
 * from FileSyncer onto a caller-defined percentage window [basePercent, maxPercent].
 */
export function makeProgressAdapter(
  report: (pct: number, msg: string) => void,
  basePercent: number,
  maxPercent: number
): { report: (opts: { message?: string; increment?: number }) => void } {
  const range = maxPercent - basePercent;
  return {
    report: ({ message }) => {
      if (!message) { return; }
      const match = message.match(/\((\d+) \/ (\d+)\)/);
      const pct = match
        ? Math.round((parseInt(match[1], 10) / parseInt(match[2], 10)) * range) + basePercent
        : basePercent;
      report(pct, message);
    },
  };
}

/** Simple semaphore for limiting concurrency */
export class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly concurrency: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}
