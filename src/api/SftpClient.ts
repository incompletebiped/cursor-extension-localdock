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
    let fileCount = 0;
    await this.walkDir(remoteBase, remoteBase, excludePatterns, results, (delta) => {
      fileCount += delta;
      onProgress?.(fileCount);
    });
    return results;
  }

  private async walkDir(
    base: string,
    current: string,
    excludePatterns: string[],
    results: RemoteFileEntry[],
    onProgress: (delta: number) => void
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
        onProgress(1);
      }
    }

    // Walk subdirectories with limited parallelism. Same reasoning as file
    // downloads — these are pipelined SFTP requests over one connection, so
    // round-trip latency (not the connection itself) is the constraint.
    const CONCURRENCY = 16;
    for (let i = 0; i < subdirs.length; i += CONCURRENCY) {
      const batch = subdirs.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((dir) => this.walkDir(base, dir, excludePatterns, results, onProgress))
      );
    }
  }

  private isExcluded(relativePath: string, patterns: string[]): boolean {
    const positivePatterns = patterns.filter(p => !p.startsWith('!'));
    const negationPatterns = patterns.filter(p => p.startsWith('!')).map(p => p.slice(1));

    // A negation pattern wins over any positive match — either the path itself
    // matches the negation glob, or the path is a parent directory that must be
    // walked to reach files the negation targets.
    for (const negPat of negationPatterns) {
      if (this.matchGlob(relativePath, negPat)) { return false; }
      const prefix = negPat.replace(/\/\*\*$/, '');
      if (prefix === relativePath || prefix.startsWith(relativePath + '/')) { return false; }
    }

    for (const pattern of positivePatterns) {
      if (this.matchGlob(relativePath, pattern)) { return true; }
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
    // SFTP servers report "already exists" as the same generic FAILURE status
    // used for other errors (ssh2 surfaces it as a numeric `.code`, never the
    // Node fs-style 'EEXIST' string) — so checking the existing directory via
    // stat first is more reliable than trying to interpret that status code.
    try {
      await this.stat(remotePath);
      return;
    } catch {
      // Doesn't exist — fall through and create it.
    }

    return new Promise((resolve, reject) => {
      this.s.mkdir(remotePath, (err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }

  /** Create a directory and all missing ancestors (like mkdir -p). */
  async mkdirp(remotePath: string): Promise<void> {
    const parts = remotePath.split('/');
    let current = '';
    for (const part of parts) {
      if (!part) {
        current = '/';
        continue;
      }
      current = current === '/' ? `/${part}` : `${current}/${part}`;
      await this.mkdir(current);
    }
  }

  close(): void {
    this.sftp?.end();
    this.sftp = undefined;
  }
}
