import * as ssh2 from 'ssh2';
import { CpanelServer } from '../models/Server';
import { ResolvedCredentials } from '../models/Credentials';
import { logger } from '../utils/logger';
import { LocalDockError, LocalDockErrorCode } from '../utils/errors';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class SshClient {
  private client: ssh2.Client = new ssh2.Client();
  private connected = false;
  private observedFingerprint: string | undefined;

  /**
   * SHA256 fingerprint (hex) of the host key presented on the most recent
   * connect() attempt, whether it was accepted or rejected. Undefined until
   * a connect attempt has actually reached the key-exchange step.
   */
  get observedHostKeyFingerprint(): string | undefined {
    return this.observedFingerprint;
  }

  async connect(server: CpanelServer, creds: ResolvedCredentials): Promise<void> {
    return new Promise((resolve, reject) => {
      const connectConfig: ssh2.ConnectConfig = {
        host: server.host,
        port: server.sshPort,
        username: server.cpanelUser,
        readyTimeout: 20000,
        hostHash: 'sha256',
        hostVerifier: (fingerprint: string): boolean => {
          this.observedFingerprint = fingerprint;
          // Trust-on-first-use: nothing pinned yet for this server — accept and
          // let the caller persist observedHostKeyFingerprint. Once pinned, any
          // later connection must present the exact same key.
          if (!server.hostKeyFingerprint) {
            return true;
          }
          return fingerprint === server.hostKeyFingerprint;
        },
      };

      if (creds.type === 'password' && creds.password) {
        connectConfig.password = creds.password;
      } else if (creds.type === 'key' && creds.privateKey) {
        connectConfig.privateKey = creds.privateKey;
        if (creds.passphrase) {
          connectConfig.passphrase = creds.passphrase;
        }
      }

      this.client.once('ready', () => {
        this.connected = true;
        logger.info(`[SshClient] Connected to ${server.host}:${server.sshPort}`);
        resolve();
      });

      this.client.once('error', (err) => {
        if (
          server.hostKeyFingerprint &&
          this.observedFingerprint &&
          this.observedFingerprint !== server.hostKeyFingerprint
        ) {
          logger.error(
            `[SshClient] Host key mismatch for ${server.host}: expected ${server.hostKeyFingerprint}, got ${this.observedFingerprint}`
          );
          reject(new LocalDockError(
            `The SSH host key presented by "${server.host}" does not match the one recorded when you first connected ` +
            `(expected ${server.hostKeyFingerprint}, got ${this.observedFingerprint}). This can mean the server was ` +
            `legitimately reinstalled or migrated — or that this connection is being intercepted. Run "Test Connection" ` +
            `on this server to review and accept the new key if you've verified it's legitimate.`,
            LocalDockErrorCode.HOST_KEY_MISMATCH,
            true
          ));
          return;
        }
        logger.error(`[SshClient] Connection error: ${err.message}`);
        reject(err);
      });

      this.client.connect(connectConfig);
    });
  }

  async exec(command: string): Promise<ExecResult> {
    if (!this.connected) {
      throw new Error('SSH client is not connected');
    }

    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) {
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          resolve({ stdout, stderr, code: code ?? 0 });
        });

        stream.on('error', reject);
      });
    });
  }

  getClient(): ssh2.Client {
    return this.client;
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      this.client.end();
      this.connected = false;
      logger.info('[SshClient] Disconnected');
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
