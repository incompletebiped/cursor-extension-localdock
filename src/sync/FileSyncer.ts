import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { SftpClient, RemoteFileEntry } from '../api/SftpClient';
import { SiteManifest } from '../models/Manifest';
import { Semaphore } from '../utils/progressUtils';
import { logger } from '../utils/logger';

export interface DownloadResult {
  fileIndex: SiteManifest['fileIndex'];
  totalFiles: number;
  /** Files that still failed to download/index after retries — the manifest
   * has no entry for these, so the next push will treat them as "added"
   * even though they may already exist correctly on disk. */
  failedFiles: string[];
}

/**
 * Retries a transient per-file failure a few times before giving up. On
 * Windows, antivirus/Defender can briefly lock a file immediately after it's
 * written, which makes the read-back in computeMd5()/fs.stat() right after a
 * successful download fail even though nothing is actually wrong with the
 * file — a short retry rides that out instead of silently dropping the file
 * from the manifest.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

export class FileSyncer {
  constructor(
    private readonly sftp: SftpClient,
    private readonly maxConcurrent: number
  ) {}

  async downloadAll(
    remoteBase: string,
    localBase: string,
    excludePatterns: string[],
    token: vscode.CancellationToken,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<DownloadResult> {
    progress.report({ message: 'Indexing remote files…' });

    let indexedCount = 0;
    const remoteFiles = await this.sftp.buildIndex(
      remoteBase,
      [...excludePatterns, '.localdock/**'],
      (count) => {
        if (count !== indexedCount) {
          indexedCount = count;
          progress.report({ message: `Indexing remote files… (${count} found)` });
        }
      }
    );

    const files = remoteFiles.filter((f) => !f.isDirectory);
    const dirs = remoteFiles.filter((f) => f.isDirectory);
    const total = files.length;

    logger.info(`[FileSyncer] Found ${total} files to download`);

    // Create local directories first (parallel)
    await Promise.all(dirs.map(dir =>
      fs.mkdir(path.join(localBase, dir.relativePath), { recursive: true })
    ));

    const semaphore = new Semaphore(this.maxConcurrent);
    const fileIndex: SiteManifest['fileIndex'] = {};
    const failedFiles: string[] = [];
    let completed = 0;

    const tasks = files.map(async (file) => {
      if (token.isCancellationRequested) {
        return;
      }

      await semaphore.acquire();
      try {
        if (token.isCancellationRequested) {
          return;
        }

        const localPath = path.join(localBase, file.relativePath);

        try {
          await withRetry(async () => {
            await this.sftp.fastGet(file.fullPath, localPath);
            const md5 = await computeMd5(localPath);
            const stat = await fs.stat(localPath);

            fileIndex[file.relativePath] = {
              size: stat.size,
              mtime: Math.floor(stat.mtimeMs / 1000),
              md5,
            };
          }, 3, 250);
        } catch (err) {
          logger.warn(
            `[FileSyncer] Failed to download ${file.relativePath} after retries: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          failedFiles.push(file.relativePath);
        }

        completed++;
        progress.report({
          message: `Downloading files… (${completed} / ${total})`,
          increment: (1 / total) * 100,
        });
      } finally {
        semaphore.release();
      }
    });

    await Promise.allSettled(tasks);

    if (failedFiles.length > 0) {
      logger.warn(`[FileSyncer] ${failedFiles.length} of ${total} file(s) failed to download after retries`);
    }

    return { fileIndex, totalFiles: total, failedFiles };
  }

  /**
   * Downloads only the given paths and removes only the given local paths —
   * the incremental counterpart to downloadAll(), used for a re-pull once a
   * manifest baseline exists so unchanged files (the vast majority of a
   * site) are never touched.
   */
  async downloadChanged(
    remoteBase: string,
    localBase: string,
    filesToDownload: string[],
    filesToDelete: string[],
    token: vscode.CancellationToken,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<DownloadResult> {
    const total = filesToDownload.length + filesToDelete.length;
    const semaphore = new Semaphore(this.maxConcurrent);
    const fileIndex: SiteManifest['fileIndex'] = {};
    const failedFiles: string[] = [];
    let completed = 0;

    const downloadTasks = filesToDownload.map(async (relPath) => {
      if (token.isCancellationRequested) {
        return;
      }

      await semaphore.acquire();
      try {
        if (token.isCancellationRequested) {
          return;
        }

        const localPath = path.join(localBase, relPath);
        const remotePath = `${remoteBase}/${relPath}`;

        try {
          await withRetry(async () => {
            await this.sftp.fastGet(remotePath, localPath);
            const md5 = await computeMd5(localPath);
            const stat = await fs.stat(localPath);

            fileIndex[relPath] = {
              size: stat.size,
              mtime: Math.floor(stat.mtimeMs / 1000),
              md5,
            };
          }, 3, 250);
        } catch (err) {
          logger.warn(
            `[FileSyncer] Failed to download ${relPath} after retries: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          failedFiles.push(relPath);
        }

        completed++;
        progress.report({
          message: `Downloading changed files… (${completed} / ${total})`,
          increment: (1 / total) * 100,
        });
      } finally {
        semaphore.release();
      }
    });

    const deleteTasks = filesToDelete.map(async (relPath) => {
      if (token.isCancellationRequested) {
        return;
      }

      await semaphore.acquire();
      try {
        const localPath = path.join(localBase, relPath);
        await fs.unlink(localPath).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn(`[FileSyncer] Failed to remove local file ${relPath}: ${err.message}`);
          }
        });
        completed++;
        progress.report({
          message: `Removing locally-deleted-on-server files… (${completed} / ${total})`,
          increment: (1 / total) * 100,
        });
      } finally {
        semaphore.release();
      }
    });

    await Promise.allSettled([...downloadTasks, ...deleteTasks]);

    if (failedFiles.length > 0) {
      logger.warn(`[FileSyncer] ${failedFiles.length} of ${filesToDownload.length} file(s) failed to download after retries`);
    }

    return { fileIndex, totalFiles: filesToDownload.length, failedFiles };
  }

  async uploadChanged(
    localBase: string,
    remoteBase: string,
    filesToUpload: string[],
    filesToDelete: string[],
    token: vscode.CancellationToken,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<SiteManifest['fileIndex']> {
    const total = filesToUpload.length + filesToDelete.length;
    const semaphore = new Semaphore(this.maxConcurrent);
    const newFileIndex: SiteManifest['fileIndex'] = {};
    const createdDirs = new Set<string>();
    let completed = 0;

    const uploadTasks = filesToUpload.map(async (relPath) => {
      if (token.isCancellationRequested) {
        return;
      }

      await semaphore.acquire();
      try {
        if (token.isCancellationRequested) {
          return;
        }

        const localPath = path.join(localBase, relPath);
        const remotePath = `${remoteBase}/${relPath}`;
        const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));

        if (!createdDirs.has(remoteDir)) {
          await this.sftp.mkdirp(remoteDir);
          createdDirs.add(remoteDir);
        }

        await this.sftp.fastPut(localPath, remotePath);

        const md5 = await computeMd5(localPath);
        const stat = await fs.stat(localPath);

        newFileIndex[relPath] = {
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs / 1000),
          md5,
        };

        completed++;
        progress.report({
          message: `Uploading files… (${completed} / ${total})`,
          increment: (1 / total) * 100,
        });
      } catch (err) {
        logger.warn(
          `[FileSyncer] Failed to upload ${relPath}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        semaphore.release();
      }
    });

    const deleteTasks = filesToDelete.map(async (relPath) => {
      if (token.isCancellationRequested) {
        return;
      }

      await semaphore.acquire();
      try {
        const remotePath = `${remoteBase}/${relPath}`;
        await this.sftp.delete(remotePath);
        completed++;
        progress.report({
          message: `Deleting remote files… (${completed} / ${total})`,
          increment: (1 / total) * 100,
        });
      } catch (err) {
        logger.warn(
          `[FileSyncer] Failed to delete ${relPath}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        semaphore.release();
      }
    });

    await Promise.allSettled([...uploadTasks, ...deleteTasks]);

    return newFileIndex;
  }
}

export async function computeMd5(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash('md5').update(data).digest('hex');
}
