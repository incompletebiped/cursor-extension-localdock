import * as vscode from 'vscode';
import { logger } from './logger';

export enum LocalWPErrorCode {
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
  UNKNOWN = 'UNKNOWN',
}

export class LocalWPError extends Error {
  constructor(
    message: string,
    public readonly code: LocalWPErrorCode,
    public readonly recoverable: boolean,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'LocalWPError';
  }
}

export function handleError(context: string, err: unknown): void {
  let message: string;
  let stack: string | undefined;

  if (err instanceof LocalWPError) {
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
    .showErrorMessage(`LocalWP cPanel: ${message}`, 'Show Logs')
    .then((choice) => {
      if (choice === 'Show Logs') {
        logger.show();
      }
    });
}

export function normalizeError(err: unknown): LocalWPError {
  if (err instanceof LocalWPError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);

  // Classify common SSH/SFTP/Axios errors
  if (err instanceof Error) {
    if (err.message.includes('All configured authentication methods failed')) {
      return new LocalWPError(message, LocalWPErrorCode.AUTH_FAILED, true, err);
    }
    if (err.message.includes('CERT_') || err.message.includes('self signed')) {
      return new LocalWPError(message, LocalWPErrorCode.SSL_CERT_ERROR, true, err);
    }
    if (err.message.includes('ENOSPC')) {
      return new LocalWPError('Local disk full', LocalWPErrorCode.DISK_FULL, false, err);
    }
    if (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED')) {
      return new LocalWPError(message, LocalWPErrorCode.SSH_TIMEOUT, true, err);
    }
  }

  return new LocalWPError(message, LocalWPErrorCode.UNKNOWN, true, err);
}
