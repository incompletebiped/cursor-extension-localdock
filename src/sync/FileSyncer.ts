import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { SftpClient, RemoteFileEntry } from '../api/SftpClient';
import { SiteManifest, ManifestFileEntry } from '../models/Manifest';
import { Semaphore } from '../utils/progressUtils';
import { logger } from '../utils/logger';

export interface DownloadResult {
  fileIndex: SiteManifest['fileIndex'];
  totalFiles: number;
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
      [...excludePatterns, '.localwp/**'],
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

    // Create local directories first
    for (const dir of dirs) {
      const localDir = path.join(localBase, dir.relativePath);
      await fs.mkdir(localDir, { recursive: true });
    }

    const semaphore = new Semaphore(this.maxConcurrent);
    const fileIndex: SiteManifest['fileIndex'] = {};
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
        await this.sftp.fastGet(file.fullPath, localPath);

        const md5 = await computeMd5(localPath);
        const stat = await fs.stat(localPath);

        fileIndex[file.relativePath] = {
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs / 1000),
          md5,
        };

        completed++;
        progress.report({
          message: `Downloading files… (${completed} / ${total})`,
          increment: (1 / total) * 100,
        });
      } catch (err) {
        logger.warn(
          `[FileSyncer] Failed to download ${file.relativePath}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        semaphore.release();
      }
    });

    await Promise.allSettled(tasks);

    return { fileIndex, totalFiles: total };
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

        // Ensure remote directory exists via SSH mkdir is handled at a higher level
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
