import axios, { AxiosInstance, AxiosError } from 'axios';
import * as https from 'https';
import { CpanelServer } from '../models/Server';
import { ResolvedCredentials } from '../models/Credentials';
import { SshClient } from './SshClient';
import { SftpClient } from './SftpClient';
import { logger } from '../utils/logger';

export interface DomainEntry {
  domain: string;
  docroot: string;
  type: 'main' | 'addon' | 'sub' | 'alias' | 'parked';
}

export interface WordPressFingerprint {
  wpVersion: string;
  dbName: string;
  dbUser: string;
  dbHost: string;
  dbPass: string;
}

export class CpanelClient {
  private http: AxiosInstance;

  constructor(
    private readonly server: CpanelServer,
    private readonly creds: ResolvedCredentials,
    rejectUnauthorizedSsl: boolean
  ) {
    this.http = axios.create({
      baseURL: `https://${server.host}:${server.cpanelPort}`,
      httpsAgent: new https.Agent({ rejectUnauthorized: rejectUnauthorizedSsl }),
      timeout: 30000,
    });

    if (creds.password) {
      const encoded = Buffer.from(`${server.cpanelUser}:${creds.password}`).toString('base64');
      this.http.defaults.headers.common['Authorization'] = `Basic ${encoded}`;
    }
  }

  /** Verify the cPanel HTTPS API is reachable and credentials work. No SSH required. */
  async testApiConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.http.get('/execute/DomainInfo/domains_data', {
        params: { format: 'json' },
        timeout: 15000,
      });
      if (response.data.status === 1) {
        return { success: true };
      }
      const errors: string[] = response.data.errors ?? [];
      return { success: false, error: errors.join(', ') || 'API returned status 0' };
    } catch (err) {
      const axiosErr = err as AxiosError;
      if (axiosErr.response?.status === 401 || axiosErr.response?.status === 403) {
        return { success: false, error: 'Invalid cPanel username or password' };
      }
      return { success: false, error: axiosErr.message };
    }
  }

  /** List all domains on the cPanel account */
  async listDomains(): Promise<DomainEntry[]> {
    logger.info(`[CpanelClient] Listing domains for ${this.server.host}`);
    const response = await this.http.get('/execute/DomainInfo/domains_data', {
      params: { format: 'json' },
    });

    const data = response.data;
    if (data.status !== 1) {
      throw new Error(`cPanel API error: ${data.errors?.join(', ')}`);
    }

    const payload = data.data;
    const domains: DomainEntry[] = [];

    if (payload.main_domain) {
      domains.push({
        domain: payload.main_domain.domain,
        docroot: payload.main_domain.documentroot,
        type: 'main',
      });
    }
    for (const d of payload.addon_domains ?? []) {
      domains.push({ domain: d.domain, docroot: d.documentroot, type: 'addon' });
    }
    for (const d of payload.sub_domains ?? []) {
      domains.push({ domain: d.domain, docroot: d.documentroot, type: 'sub' });
    }

    logger.info(`[CpanelClient] Found ${domains.length} domains`);
    return domains;
  }

  /**
   * Detect WordPress using only the cPanel HTTPS API (no SSH required).
   * Reads wp-config.php via the cPanel Fileman API.
   */
  async detectWordPressViaApi(domain: DomainEntry): Promise<WordPressFingerprint | null> {
    const { docroot } = domain;

    // Check wp-config.php exists and read it
    let configContent: string;
    try {
      const response = await this.http.get('/execute/Fileman/get_file_content', {
        params: { dir: docroot, file: 'wp-config.php' },
      });
      if (response.data.status !== 1) {
        return null;
      }
      configContent = response.data.data?.content ?? '';
      if (!configContent) {
        return null;
      }
    } catch {
      return null;
    }

    // Confirm it actually looks like a WordPress config
    if (!configContent.includes('DB_NAME')) {
      return null;
    }

    const extract = (key: string): string => {
      const match = configContent.match(new RegExp(`DB_${key}['"\\s,]+['"]([^'"]+)`));
      return match?.[1] ?? '';
    };

    // Try to get WP version from wp-includes/version.php
    let wpVersion = 'unknown';
    try {
      const versionResponse = await this.http.get('/execute/Fileman/get_file_content', {
        params: { dir: `${docroot}/wp-includes`, file: 'version.php' },
      });
      if (versionResponse.data.status === 1) {
        const content: string = versionResponse.data.data?.content ?? '';
        const match = content.match(/\$wp_version\s*=\s*'([^']+)'/);
        if (match) { wpVersion = match[1]; }
      }
    } catch {
      // version unknown is fine
    }

    logger.debug(`[CpanelClient] WP detected via API: ${domain.domain} (WP ${wpVersion})`);

    return {
      wpVersion,
      dbName: extract('NAME'),
      dbUser: extract('USER'),
      dbHost: extract('HOST') || 'localhost',
      dbPass: extract('PASSWORD'),
    };
  }

  /**
   * Detect WordPress using SSH+SFTP (faster, used when SSH is available).
   */
  private validateDocroot(docroot: string): void {
    if (!/^\/[a-zA-Z0-9_.\-/]+$/.test(docroot)) {
      throw new Error(`Unsafe docroot path rejected: ${docroot}`);
    }
  }

  async detectWordPress(
    sftpClient: SftpClient,
    sshClient: SshClient,
    domain: DomainEntry
  ): Promise<WordPressFingerprint | null> {
    const { docroot } = domain;
    this.validateDocroot(docroot);

    // Strategy 1: SFTP stat
    try {
      const [loginStat, versionStat] = await Promise.allSettled([
        sftpClient.stat(`${docroot}/wp-login.php`),
        sftpClient.stat(`${docroot}/wp-includes/version.php`),
      ]);
      if (loginStat.status === 'fulfilled' && versionStat.status === 'fulfilled') {
        logger.debug(`[CpanelClient] WP detected via SFTP stat: ${domain.domain}`);
        return this.extractWpDetailsViaSsh(sshClient, docroot);
      }
    } catch { /* fall through */ }

    // Strategy 2: SSH test
    try {
      const test = await sshClient.exec(
        `test -f ${docroot}/wp-config.php && echo YES || echo NO`
      );
      if (test.stdout.trim() === 'YES') {
        logger.debug(`[CpanelClient] WP detected via SSH: ${domain.domain}`);
        return this.extractWpDetailsViaSsh(sshClient, docroot);
      }
    } catch { /* not WordPress or SSH failed */ }

    return null;
  }

  private async extractWpDetailsViaSsh(
    ssh: SshClient,
    docroot: string
  ): Promise<WordPressFingerprint> {
    const [versionResult, configResult] = await Promise.all([
      ssh
        .exec(`grep "wp_version = " ${docroot}/wp-includes/version.php | sed "s/.*'\\(.*\\)'.*/\\1/"`)
        .catch(() => ({ stdout: 'unknown', stderr: '', code: 0 })),
      ssh.exec(`grep -E "DB_(NAME|USER|HOST|PASSWORD)" ${docroot}/wp-config.php`),
    ]);

    const wpVersion = versionResult.stdout.trim() || 'unknown';
    const configText = configResult.stdout;
    const extract = (key: string): string =>
      configText.match(new RegExp(`DB_${key}['"\\s,]+['"]([^'"]+)`))?.[1] ?? '';

    return {
      wpVersion,
      dbName: extract('NAME'),
      dbUser: extract('USER'),
      dbHost: extract('HOST') || 'localhost',
      dbPass: extract('PASSWORD'),
    };
  }
}
