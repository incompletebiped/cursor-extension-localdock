import * as ssh2 from 'ssh2';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SshClient } from './SshClient';
import { logger } from '../utils/logger';

export interface RemoteFileEntry {
  relativePath: string;
  fullPath: string;
  size: number;
  mtime: number;
  isDirectory: boolean;
}

export class SftpClient {
  private sftp: ssh2.SFTPWrapper | undefined;

  async open(sshClient: SshClient): Promise<void> {
    return new Promise((resolve, reject) => {
      sshClient.getClient().sftp((err, sftp) => {
        if (err) {
          return reject(err);
        }
        this.sftp = sftp;
        logger.info('[SftpClient] SFTP session opened');
        resolve();
      });
    });
  }

  private get s(): ssh2.SFTPWrapper {
    if (!this.sftp) {
      throw new Error('SFTP session not opened');
    }
    return this.sftp;
  }

  async stat(remotePath: string): Promise<ssh2.Stats> {
    return new Promise((resolve, reject) => {
      this.s.stat(remotePath, (err, stats) => {
        if (err) {
          return reject(err);
        }
        resolve(stats);
      });
    });
  }

  async readdir(remotePath: string): Promise<ssh2.FileEntry[]> {
    return new Promise((resolve, reject) => {
      this.s.readdir(remotePath, (err, list) => {
        if (err) {
          return reject(err);
        }
        resolve(list);
      });
    });
  }

  /**
   * Recursively walk remote directory, respecting exclude patterns.
   * onProgress is called with a running file count so the UI stays responsive.
   */
  async buildIndex(
    remoteBase: string,
    excludePatterns: string[],
    onProgress?: (fileCount: number) => void
  ): Promise<RemoteFileEntry[]> {
    const results: RemoteFileEntry[] = [];
    await this.walkDir(remoteBase, remoteBase, excludePatterns, results, onProgress ?? (() => {}));
    return results;
  }

  private async walkDir(
    base: string,
    current: string,
    excludePatterns: string[],
    results: RemoteFileEntry[],
    onProgress: (count: number) => void
  ): Promise<void> {
    let entries: ssh2.FileEntry[];
    try {
      entries = await this.readdir(current);
    } catch {
      logger.warn(`[SftpClient] Cannot read directory: ${current}`);
      return;
    }

    const subdirs: string[] = [];

    for (const entry of entries) {
      const fullPath = `${current}/${entry.filename}`;
      const relativePath = fullPath.slice(base.length + 1);

      if (this.isExcluded(relativePath, excludePatterns)) {
        continue;
      }

      const isDirectory = ((entry.attrs.mode ?? 0) & 0o170000) === 0o040000;
      results.push({
        relativePath,
        fullPath,
        size: entry.attrs.size,
        mtime: entry.attrs.mtime,
        isDirectory,
      });

      if (isDirectory) {
        subdirs.push(fullPath);
      } else {
        onProgress(results.filter(r => !r.isDirectory).length);
      }
    }

    // Walk subdirectories with limited parallelism (4 concurrent) to stay fast
    // without overwhelming the SFTP connection
    const CONCURRENCY = 4;
    for (let i = 0; i < subdirs.length; i += CONCURRENCY) {
      const batch = subdirs.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((dir) => this.walkDir(base, dir, excludePatterns, results, onProgress))
      );
    }
  }

  private isExcluded(relativePath: string, patterns: string[]): boolean {
    // Simple glob matching without external dependencies
    for (const pattern of patterns) {
      if (this.matchGlob(relativePath, pattern)) {
        return true;
      }
    }
    return false;
  }

  private matchGlob(filePath: string, pattern: string): boolean {
    // Convert glob to regex
    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<DOUBLESTAR>>>/g, '.*');
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(filePath);
  }

  async fastGet(remotePath: string, localPath: string): Promise<void> {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    return new Promise((resolve, reject) => {
      this.s.fastGet(remotePath, localPath, (err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }

  async fastPut(localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.s.fastPut(localPath, remotePath, (err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }

  async delete(remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.s.unlink(remotePath, (err) => {
        if (err) {
          // File not existing during delete is fine
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return resolve();
          }
          return reject(err);
        }
        resolve();
      });
    });
  }

  async mkdir(remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.s.mkdir(remotePath, (err) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'EEXIST') {
          return reject(err);
        }
        resolve();
      });
    });
  }

  close(): void {
    this.sftp?.end();
    this.sftp = undefined;
  }
}
