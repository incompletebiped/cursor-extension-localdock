import * as vscode from 'vscode';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private channel: vscode.OutputChannel | undefined;

  initialize(_context: vscode.ExtensionContext): void {
    this.channel = vscode.window.createOutputChannel('LocalWP cPanel');
  }

  show(): void {
    this.channel?.show();
  }

  debug(message: string): void {
    this.log('DEBUG', message);
  }

  info(message: string): void {
    this.log('INFO', message);
  }

  warn(message: string): void {
    this.log('WARN', message);
  }

  error(message: string): void {
    this.log('ERROR', message);
  }

  private log(level: Uppercase<LogLevel>, message: string): void {
    const timestamp = new Date().toISOString();
    this.channel?.appendLine(`[${timestamp}] [${level}] ${message}`);
  }
}

export const logger = new Logger();
