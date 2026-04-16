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
