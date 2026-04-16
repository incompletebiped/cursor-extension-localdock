import * as vscode from 'vscode';
import { logger } from './logger';

export enum LocalDockErrorCode {
  AUTH_FAILED = 'AUTH_FAILED',
  SSL_CERT_ERROR = 'SSL_CERT_ERROR',
  SFTP_PERMISSION = 'SFTP_PERMISSION',
  SSH_TIMEOUT = 'SSH_TIMEOUT',
  DISK_FULL = 'DISK_FULL',
  DB_EXPORT_FAILED = 'DB_EXPORT_FAILED',
  DB_IMPORT_FAILED = 'DB_IMPORT_FAILED',
  MANIFEST_MISSING = 'MANIFEST_MISSING',
  CONFLICT_DETECTED = 'CONFLICT_DETECTED',
  CANCELLED = 'CANCELLED',
  DOCKER_NOT_FOUND = 'DOCKER_NOT_FOUND',
  DOCKER_START_FAILED = 'DOCKER_START_FAILED',
  DOCKER_STOP_FAILED = 'DOCKER_STOP_FAILED',
  UNKNOWN = 'UNKNOWN',
}

export class LocalDockError extends Error {
  constructor(
    message: string,
    public readonly code: LocalDockErrorCode,
    public readonly recoverable: boolean,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'LocalDockError';
  }
}

export function handleError(context: string, err: unknown): void {
  let message: string;
  let stack: string | undefined;

  if (err instanceof LocalDockError) {
    message = err.message;
    stack = err.stack;
    if (err.cause instanceof Error) {
      logger.debug(`[${context}] Caused by: ${err.cause.message}`);
    }
  } else if (err instanceof Error) {
    message = err.message;
    stack = err.stack;
  } else {
    message = String(err);
  }

  logger.error(`[${context}] ${message}`);
  if (stack) {
    logger.debug(stack);
  }

  vscode.window
    .showErrorMessage(`LocalDock cPanel: ${message}`, 'Show Logs')
    .then((choice) => {
      if (choice === 'Show Logs') {
        logger.show();
      }
    });
}

export function normalizeError(err: unknown): LocalDockError {
  if (err instanceof LocalDockError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);

  // Classify common SSH/SFTP/Axios errors
  if (err instanceof Error) {
    if (err.message.includes('All configured authentication methods failed')) {
      return new LocalDockError(message, LocalDockErrorCode.AUTH_FAILED, true, err);
    }
    if (err.message.includes('CERT_') || err.message.includes('self signed')) {
      return new LocalDockError(message, LocalDockErrorCode.SSL_CERT_ERROR, true, err);
    }
    if (err.message.includes('ENOSPC')) {
      return new LocalDockError('Local disk full', LocalDockErrorCode.DISK_FULL, false, err);
    }
    if (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED')) {
      return new LocalDockError(message, LocalDockErrorCode.SSH_TIMEOUT, true, err);
    }
  }

  return new LocalDockError(message, LocalDockErrorCode.UNKNOWN, true, err);
}
