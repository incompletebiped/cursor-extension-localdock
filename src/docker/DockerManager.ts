import * as fs from 'fs/promises';
import * as path from 'path';
import * as net from 'net';
import * as child_process from 'child_process';
import { ConfigManager } from '../utils/configManager';
import { logger } from '../utils/logger';
import { LocalDockError, LocalDockErrorCode } from '../utils/errors';
import { LocalEnvStatus } from '../models/LocalEnvState';
import { SiteManifest } from '../models/Manifest';
import { sanitizeDbName } from '../utils/pathUtils';

export class DockerManager {
  constructor(private readonly configManager: ConfigManager) {}

  /** Check that the docker CLI is in PATH. Throws DOCKER_NOT_FOUND if not. */
  async assertDockerAvailable(): Promise<void> {
    const version = await this.getDockerVersion();
    if (version === null) {
      throw new LocalDockError(
        'Docker Desktop is not installed or not in PATH. Download it from https://www.docker.com/products/docker-desktop',
        LocalDockErrorCode.DOCKER_NOT_FOUND,
        false
      );
    }
  }

  /** Returns Docker version string, or null if unavailable. */
  async getDockerVersion(): Promise<string | null> {
    try {
      const result = await this.spawnCompose(['--version'], null);
      if (result.code === 0) {
        return result.stdout.trim().replace(/^Docker version\s*/i, '').split(',')[0];
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Assign a free port for a site. Reuses manifest.localPort if still free,
   * otherwise finds the next free port starting from dockerStartPort.
   */
  async assignPort(localPath: string, manifest: SiteManifest | null): Promise<number> {
    // Reuse existing port if still free
    if (manifest?.localPort) {
      if (await this.isPortFree(manifest.localPort)) {
        return manifest.localPort;
      }
    }

    const usedPorts = await this.getUsedPorts(localPath);
    let port = this.configManager.dockerStartPort;

    while (!(await this.isPortFree(port)) || usedPorts.has(port)) {
      port++;
    }
    return port;
  }

  /**
   * Scaffold a docker-compose.yml in localPath/.localdock/ if one doesn't exist.
   * Returns the path to the compose file.
   */
  async scaffoldComposeFile(
    localPath: string,
    domain: string,
    port: number,
    dbName: string
  ): Promise<string> {
    const localDockDir = path.join(localPath, '.localdock');
    const composePath = path.join(localDockDir, 'docker-compose.yml');

    await fs.mkdir(localDockDir, { recursive: true });

    // Don't overwrite existing file — user may have customized it
    try {
      await fs.access(composePath);
      logger.info(`[DockerManager] docker-compose.yml already exists for ${domain}, skipping scaffold`);
      return composePath;
    } catch {
      // File doesn't exist, create it
    }

    const safeVolumeName = sanitizeDbName(domain);
    const content = this.buildComposeTemplate(port, dbName, safeVolumeName);

    await fs.writeFile(composePath, content, 'utf-8');
    logger.info(`[DockerManager] Scaffolded docker-compose.yml for ${domain} on port ${port}`);
    return composePath;
  }

  /** Start the Docker Compose stack (docker compose up -d) */
  async start(localPath: string): Promise<void> {
    logger.info(`[DockerManager] Starting local environment at ${localPath}`);
    const result = await this.spawnCompose(['up', '-d', '--wait'], localPath);
    if (result.code !== 0) {
      throw new LocalDockError(
        `docker compose up failed: ${result.stderr}`,
        LocalDockErrorCode.DOCKER_START_FAILED,
        true
      );
    }
  }

  /** Stop the Docker Compose stack (docker compose down) */
  async stop(localPath: string): Promise<void> {
    logger.info(`[DockerManager] Stopping local environment at ${localPath}`);
    const result = await this.spawnCompose(['down'], localPath);
    if (result.code !== 0) {
      throw new LocalDockError(
        `docker compose down failed: ${result.stderr}`,
        LocalDockErrorCode.DOCKER_STOP_FAILED,
        true
      );
    }
  }

  /** Get the current status of the Docker Compose stack */
  async getStatus(localPath: string): Promise<LocalEnvStatus> {
    const composePath = path.join(localPath, '.localdock', 'docker-compose.yml');

    // If no compose file, environment hasn't been initialized
    try {
      await fs.access(composePath);
    } catch {
      return 'stopped';
    }

    const result = await this.spawnCompose(['ps', '--format', 'json'], localPath);
    if (result.code !== 0) {
      return 'error';
    }

    const output = result.stdout.trim();
    if (!output || output === '[]' || output === '') {
      return 'stopped';
    }

    try {
      // Docker compose ps --format json can output either a JSON array or
      // one JSON object per line (newer Docker versions)
      let containers: Array<{ State?: string; Status?: string }> = [];
      if (output.startsWith('[')) {
        containers = JSON.parse(output);
      } else {
        // One JSON object per line
        containers = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
      }

      if (containers.length === 0) {
        return 'stopped';
      }

      const running = containers.filter(c => c.State === 'running' || c.Status?.includes('Up'));
      if (running.length === containers.length) {
        return 'running';
      }
      if (running.length > 0) {
        return 'starting'; // partially up
      }
      return 'stopped';
    } catch {
      return 'stopped';
    }
  }

  /**
   * Patch wp-config.php to use the Docker MySQL container credentials.
   * Backs up to .localdock/wp-config.docker.bak before modifying.
   * Idempotent — skips if backup already exists.
   */
  async patchWpConfig(localPath: string): Promise<void> {
    const wpConfigPath = path.join(localPath, 'wp-config.php');
    const backupPath = path.join(localPath, '.localdock', 'wp-config.docker.bak');

    // Check if we already patched (backup exists)
    try {
      await fs.access(backupPath);
      logger.info(`[DockerManager] wp-config.php already patched for ${localPath}`);
      return;
    } catch {
      // No backup yet, proceed
    }

    let content: string;
    try {
      content = await fs.readFile(wpConfigPath, 'utf-8');
    } catch {
      logger.warn(`[DockerManager] wp-config.php not found at ${wpConfigPath}, skipping patch`);
      return;
    }

    // Save backup
    await fs.writeFile(backupPath, content, 'utf-8');

    // Replace DB connection constants
    const replacements: Array<[RegExp, string]> = [
      [/define\s*\(\s*['"]DB_HOST['"]\s*,\s*['"][^'"]*['"]\s*\)/g, `define( 'DB_HOST', 'db' )`],
      [/define\s*\(\s*['"]DB_USER['"]\s*,\s*['"][^'"]*['"]\s*\)/g, `define( 'DB_USER', 'wordpress' )`],
      [/define\s*\(\s*['"]DB_PASSWORD['"]\s*,\s*['"][^'"]*['"]\s*\)/g, `define( 'DB_PASSWORD', 'wordpress' )`],
      [/define\s*\(\s*['"]DB_NAME['"]\s*,\s*['"][^'"]*['"]\s*\)/g, `define( 'DB_NAME', 'wordpress' )`],
    ];

    let patched = content;
    for (const [pattern, replacement] of replacements) {
      patched = patched.replace(pattern, replacement);
    }

    if (patched === content) {
      logger.warn(`[DockerManager] wp-config.php patterns not found, skipping patch`);
      return;
    }

    await fs.writeFile(wpConfigPath, patched, 'utf-8');
    logger.info(`[DockerManager] Patched wp-config.php for Docker`);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildComposeTemplate(port: number, dbName: string, safeVolumeName: string): string {
    return `services:
  wordpress:
    image: wordpress:latest
    ports:
      - "${port}:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: wordpress
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - ../:/var/www/html
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  db:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: rootpassword
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wordpress
      MYSQL_PASSWORD: wordpress
    volumes:
      - ${safeVolumeName}_db:/var/lib/mysql
      - ./db.sql:/docker-entrypoint-initdb.d/db.sql:ro
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      timeout: 10s
      retries: 10
    restart: unless-stopped

volumes:
  ${safeVolumeName}_db:
`;
  }

  /**
   * Check if a TCP port is free by attempting to bind to it.
   */
  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  /**
   * Read all manifests in localSitesDirectory to collect already-assigned ports.
   * This prevents two sites from getting the same port even if one is stopped.
   */
  private async getUsedPorts(excludeLocalPath: string): Promise<Set<number>> {
    const used = new Set<number>();
    const baseDir = this.configManager.localSitesDirectory;

    try {
      const entries = await fs.readdir(baseDir);
      for (const entry of entries) {
        const manifestPath = path.join(baseDir, entry, '.localdock', 'manifest.json');
        if (path.join(baseDir, entry) === excludeLocalPath) { continue; }
        try {
          const raw = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(raw) as SiteManifest;
          if (manifest.localPort) {
            used.add(manifest.localPort);
          }
        } catch {
          // No manifest or unreadable — skip
        }
      }
    } catch {
      // localSitesDirectory doesn't exist yet
    }

    return used;
  }

  /**
   * Spawn a docker or docker compose command.
   * When localPath is provided, uses the .localdock/docker-compose.yml in that directory.
   * When localPath is null, just runs `docker <args>`.
   */
  private spawnCompose(
    args: string[],
    localPath: string | null
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let command: string;
      let spawnArgs: string[];

      if (localPath !== null) {
        const composePath = path.join(localPath, '.localdock', 'docker-compose.yml');
        command = 'docker';
        spawnArgs = ['compose', '--project-directory', localPath, '--file', composePath, ...args];
      } else {
        command = 'docker';
        spawnArgs = args;
      }

      logger.debug(`[DockerManager] Spawning: ${command} ${spawnArgs.join(' ')}`);

      const proc = child_process.spawn(command, spawnArgs, {
        windowsHide: true,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        const line = data.toString();
        stdout += line;
        logger.debug(`[docker] ${line.trim()}`);
      });

      proc.stderr.on('data', (data: Buffer) => {
        const line = data.toString();
        stderr += line;
        logger.debug(`[docker stderr] ${line.trim()}`);
      });

      proc.on('error', (err) => {
        resolve({ code: 1, stdout, stderr: err.message });
      });

      proc.on('close', (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}
