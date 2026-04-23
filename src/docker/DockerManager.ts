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

  /** Returns true if the Docker daemon is responsive. */
  async isDaemonRunning(): Promise<boolean> {
    try {
      const result = await this.spawnCompose(['info'], null);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Attempt to launch Docker Desktop (best-effort, fire-and-forget).
   * Tries the standard install path on Windows with AppData fallback;
   * uses `open -a Docker` on macOS.
   */
  launchDockerDesktop(): void {
    try {
      if (process.platform === 'win32') {
        const primary = path.join('C:', 'Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
        const proc = child_process.spawn(primary, [], { detached: true, stdio: 'ignore' });
        proc.on('error', () => {
          const fallback = path.join(process.env['LOCALAPPDATA'] ?? 'C:', 'Docker', 'Docker Desktop.exe');
          child_process.spawn(fallback, [], { detached: true, stdio: 'ignore' }).unref();
        });
        proc.unref();
      } else if (process.platform === 'darwin') {
        child_process.spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (err) {
      logger.warn(`[DockerManager] Failed to launch Docker Desktop: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Assign a free port block for a site. Requires three consecutive free ports:
   * port (WordPress), port+1 (Mailpit), port+2 (Adminer).
   * Reuses manifest.localPort if the full block is still free.
   */
  async assignPort(localPath: string, manifest: SiteManifest | null): Promise<number> {
    const usedPorts = await this.getUsedPorts(localPath);

    const blockFree = async (p: number): Promise<boolean> =>
      (await this.isPortFree(p)) &&
      (await this.isPortFree(p + 1)) &&
      (await this.isPortFree(p + 2)) &&
      !usedPorts.has(p) &&
      !usedPorts.has(p + 1) &&
      !usedPorts.has(p + 2);

    // Reuse existing port block if all three slots are still free
    if (manifest?.localPort && await blockFree(manifest.localPort)) {
      return manifest.localPort;
    }

    let port = this.configManager.dockerStartPort;
    while (!(await blockFree(port))) {
      port++;
    }
    return port;
  }

  /**
   * Scaffold a docker-compose.yml in localPath/.localdock/ if one doesn't exist.
   * Returns the path to the compose file and whether it was newly created.
   */
  async scaffoldComposeFile(
    localPath: string,
    domain: string,
    port: number,
    dbName: string
  ): Promise<{ composePath: string; wasCreated: boolean }> {
    const localDockDir = path.join(localPath, '.localdock');
    const composePath = path.join(localDockDir, 'docker-compose.yml');

    await fs.mkdir(localDockDir, { recursive: true });

    // Keep existing file only if it already uses the sentinel healthcheck.
    // Files generated before the sentinel fix use the old `_options$` pattern
    // which fires as soon as `CREATE TABLE wp_options` runs (before any INSERTs),
    // letting WordPress boot with an empty options table and Astra fall back to
    // defaults.  Regenerating the file here causes startLocal to enter the full
    // reset path — wiping volumes and re-importing db.sql — which fixes the issue
    // transparently without requiring the user to run "Reset Local Config".
    try {
      await fs.access(composePath);
      const existing = await fs.readFile(composePath, 'utf-8');
      if (existing.includes('localdock_ready')) {
        logger.info(`[DockerManager] docker-compose.yml already exists for ${domain}, skipping scaffold`);
        return { composePath, wasCreated: false };
      }
      logger.info(`[DockerManager] Stale healthcheck in docker-compose.yml for ${domain} — regenerating`);
    } catch {
      // File doesn't exist, create it
    }

    const safeVolumeName = sanitizeDbName(domain);
    const content = this.buildComposeTemplate(port, dbName, safeVolumeName);

    await fs.writeFile(composePath, content, 'utf-8');
    logger.info(`[DockerManager] Scaffolded docker-compose.yml for ${domain} on port ${port}`);
    return { composePath, wasCreated: true };
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

  /** Tear down the stack and delete its volumes — forces a clean re-init on next start. */
  async reset(localPath: string): Promise<void> {
    logger.info(`[DockerManager] Resetting environment at ${localPath}`);
    await this.spawnCompose(['down', '--volumes', '--remove-orphans'], localPath);
    // Delete the compose file so scaffoldComposeFile regenerates it from the latest template
    const composePath = path.join(localPath, '.localdock', 'docker-compose.yml');
    await fs.unlink(composePath).catch(() => {});
  }

  /** Stop the Docker Compose stack (docker compose down) */
  async stop(localPath: string): Promise<void> {
    logger.info(`[DockerManager] Stopping local environment at ${localPath}`);
    const result = await this.spawnCompose(['down', '--remove-orphans'], localPath);
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
    } catch (err) {
      logger.warn(`[DockerManager] Failed to parse docker compose ps output: ${err instanceof Error ? err.message : String(err)}`);
      return 'stopped';
    }
  }

  /**
   * Patch wp-config.php to use the Docker MySQL container credentials.
   * Backs up to .localdock/wp-config.docker.bak before modifying.
   * Idempotent — skips if backup already exists.
   */
  async patchWpConfig(localPath: string, localUrl: string): Promise<void> {
    const wpConfigPath = path.join(localPath, 'wp-config.php');
    const backupPath = path.join(localPath, '.localdock', 'wp-config.docker.bak');

    // Always derive the patched file from the backup (original production copy).
    // This ensures WP_HOME/WP_SITEURL always reflect the current port, even if it
    // changed between starts. On the first run there is no backup yet, so we create
    // it from the live file and then patch from it.
    let original: string;
    try {
      original = await fs.readFile(backupPath, 'utf-8');
    } catch {
      // No backup — create one from the current wp-config.php
      try {
        original = await fs.readFile(wpConfigPath, 'utf-8');
      } catch {
        logger.warn(`[DockerManager] wp-config.php not found at ${wpConfigPath}, skipping patch`);
        return;
      }
      await fs.writeFile(backupPath, original, 'utf-8');
    }

    const replacements: Array<[RegExp, string]> = [
      [/define\s*\(\s*['"]DB_HOST['"]\s*,\s*['"][^'"]*['"]\s*\)/g,           `define( 'DB_HOST', 'db' )`],
      [/define\s*\(\s*['"]DB_USER['"]\s*,\s*['"][^'"]*['"]\s*\)/g,           `define( 'DB_USER', 'wordpress' )`],
      [/define\s*\(\s*['"]DB_PASSWORD['"]\s*,\s*['"][^'"]*['"]\s*\)/g,       `define( 'DB_PASSWORD', 'wordpress' )`],
      [/define\s*\(\s*['"]DB_NAME['"]\s*,\s*['"][^'"]*['"]\s*\)/g,           `define( 'DB_NAME', 'wordpress' )`],
      [/define\s*\(\s*['"]WP_HOME['"]\s*,\s*['"][^'"]*['"]\s*\)/g,           `define( 'WP_HOME', '${localUrl}' )`],
      [/define\s*\(\s*['"]WP_SITEURL['"]\s*,\s*['"][^'"]*['"]\s*\)/g,       `define( 'WP_SITEURL', '${localUrl}' )`],
      [/define\s*\(\s*['"]DISALLOW_FILE_EDIT['"]\s*,\s*[^)]+\)/g,           `define( 'DISALLOW_FILE_EDIT', false )`],
      [/define\s*\(\s*['"]DISALLOW_FILE_MODS['"]\s*,\s*[^)]+\)/g,           `define( 'DISALLOW_FILE_MODS', false )`],
    ];

    let patched = original;
    for (const [pattern, replacement] of replacements) {
      patched = patched.replace(pattern, replacement);
    }

    // Build a block of constants that must be injected if absent in the original.
    // Always inject dev-only overrides regardless of whether the constant existed —
    // the regex replacements above already handle the "exists" case.
    const injections: string[] = [];
    if (!/define\s*\(\s*['"]WP_HOME['"]/i.test(original)) {
      injections.push(`define( 'WP_HOME', '${localUrl}' );`);
      injections.push(`define( 'WP_SITEURL', '${localUrl}' );`);
    }
    if (!/define\s*\(\s*['"]DISALLOW_FILE_EDIT['"]/i.test(original)) {
      injections.push(`define( 'DISALLOW_FILE_EDIT', false );`);
    }
    if (!/define\s*\(\s*['"]DISALLOW_FILE_MODS['"]/i.test(original)) {
      injections.push(`define( 'DISALLOW_FILE_MODS', false );`);
    }

    if (injections.length > 0) {
      const block = injections.join('\n');
      const before = patched;

      // Primary: insert before the standard "That's all, stop editing!" comment
      patched = patched.replace(
        /(\/\*\s*That'?s all[^*]*\*\/)/i,
        `${block}\n\n$1`
      );

      // Fallback: insert before require_once ABSPATH (always present in wp-config.php)
      if (patched === before) {
        patched = patched.replace(
          /(require_once\s+ABSPATH[^;]+;)/i,
          `${block}\n\n$1`
        );
      }

      // Last resort: append to end of file
      if (patched === before) {
        patched += `\n${block}\n`;
      }
    }

    await fs.writeFile(wpConfigPath, patched, 'utf-8');
    logger.info(`[DockerManager] Patched wp-config.php for Docker (${localUrl})`);
  }

  /**
   * Strip HTTPS-redirect and canonical-domain rewrite rules from the root
   * .htaccess so the local HTTP-only Docker container can serve CSS/JS without
   * every request getting 301'd to https://localhost which doesn't exist.
   * Leaves the standard WordPress permalink block intact.
   * Idempotent — safe to call on every startLocal.
   */
  async sanitizeRootHtaccess(localPath: string): Promise<void> {
    const htaccessPath = path.join(localPath, '.htaccess');
    let content: string;
    try {
      content = await fs.readFile(htaccessPath, 'utf-8');
    } catch {
      return;
    }

    const lines = content.split('\n');
    const filtered = lines.filter((line) => {
      const t = line.trim();
      // HTTPS-off condition: RewriteCond %{HTTPS} off
      if (/^RewriteCond\s+%\{HTTPS\}\s+off/i.test(t)) { return false; }
      // Server-port-based HTTP detection: RewriteCond %{SERVER_PORT} !=443
      if (/^RewriteCond\s+%\{SERVER_PORT\}/i.test(t)) { return false; }
      // Canonical-domain redirect condition: RewriteCond %{HTTP_HOST} !^...
      if (/^RewriteCond\s+%\{HTTP_HOST\}\s+!/i.test(t)) { return false; }
      // Any RewriteRule that redirects to an absolute https:// URL
      if (/^RewriteRule\s+\S+\s+https?:\/\/[^\s]+\s+\[.*R=/i.test(t)) { return false; }
      return true;
    });

    const sanitized = filtered.join('\n');
    if (sanitized !== content) {
      await fs.writeFile(htaccessPath, sanitized, 'utf-8');
      logger.info(`[DockerManager] Sanitized root .htaccess at ${localPath}`);
    }
  }

  /**
   * Create wp-content/uploads/.htaccess so Apache redirects requests for
   * missing upload files to the production server. This avoids having to
   * download gigabytes of media just for local development.
   * Idempotent — overwrites on every start so the production URL stays current.
   */
  async scaffoldUploadsProxy(localPath: string, domain: string): Promise<void> {
    const uploadsDir = path.join(localPath, 'wp-content', 'uploads');
    const htaccessPath = path.join(uploadsDir, '.htaccess');

    await fs.mkdir(uploadsDir, { recursive: true });

    const content = `<IfModule mod_rewrite.c>
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteRule ^(.*)$ https://${domain}/wp-content/uploads/$1 [R=302,L]
</IfModule>
`;
    await fs.writeFile(htaccessPath, content, 'utf-8');
    logger.info(`[DockerManager] Wrote uploads proxy .htaccess for ${domain}`);
  }

  /**
   * Write wp-content/mu-plugins/localdock-dev-env.php.
   * Deactivates asset-optimization and page-caching plugins so WordPress serves
   * individual CSS/JS files instead of regenerated bundles that would be missing
   * uploads-based generated CSS (UAG, Hummingbird, etc.).
   * On first boot (detected via .localdock/needs-init sentinel), clears all
   * WordPress transients so stale production-URL caches don't override fresh DB values.
   * Always overwrites — the plugin body may change between extension versions.
   */
  async scaffoldDevPlugin(localPath: string): Promise<void> {
    const muPluginsDir = path.join(localPath, 'wp-content', 'mu-plugins');
    const pluginPath = path.join(muPluginsDir, 'localdock-dev-env.php');

    await fs.mkdir(muPluginsDir, { recursive: true });

    const content = `<?php
/**
 * LocalDock: Dev environment helpers.
 * Auto-generated — do not edit. Not pushed to production.
 */

// On first boot after a DB import:
//  1. Replace production URLs with the local URL using PHP's own serialization
//     functions — so byte counts in astra-settings and other serialized options
//     stay correct. Raw SQL text replacement corrupts these counts when the
//     serialized value contains single quotes (e.g. CSS url('...')).
//  2. Clear all transients that may cache stale production-URL data.
//  3. Bump Astra's CSS build version so it regenerates from fresh DB settings.
// startLocal writes .localdock/needs-init before docker compose up; this hook
// deletes it so subsequent requests skip the replacement.
add_action( 'init', function () {
    $flag     = ABSPATH . '.localdock/needs-init';
    $url_file = ABSPATH . '.localdock/production-url';
    if ( ! file_exists( $flag ) ) {
        return;
    }

    // Replace production URLs in every option that contains them.
    if ( file_exists( $url_file ) ) {
        $prod = rtrim( trim( file_get_contents( $url_file ) ), '/' );
        $local = rtrim( home_url(), '/' );

        if ( $prod && $prod !== $local ) {
            // Handle both http and https variants of the production URL.
            $variants = array_unique( [
                $prod,
                preg_replace( '#^https://#', 'http://', $prod ),
                preg_replace( '#^http://#',  'https://', $prod ),
            ] );

            global $wpdb;
            foreach ( $variants as $from ) {
                $rows = $wpdb->get_results( $wpdb->prepare(
                    "SELECT option_id, option_name, option_value
                       FROM {$wpdb->options}
                      WHERE option_value LIKE %s",
                    '%' . $wpdb->esc_like( $from ) . '%'
                ) );

                foreach ( $rows as $row ) {
                    $decoded = maybe_unserialize( $row->option_value );
                    $updated = _localdock_replace( $decoded, $from, $local );
                    if ( $updated !== $decoded ) {
                        update_option( $row->option_name, $updated );
                    }
                }
            }
        }
    }

    // Wipe transients and regenerate Astra CSS from the now-corrected settings.
    global $wpdb;
    $wpdb->query(
        "DELETE FROM \`{$wpdb->options}\`
          WHERE \`option_name\` LIKE '\\_transient\\_%'
             OR \`option_name\` LIKE '\\_site\\_transient\\_%'"
    );
    update_option( 'astra_dynamic_css_build_version', time() );

    @unlink( $flag );
}, 1 );

// Recursive URL replacement that respects PHP arrays and objects.
// Using str_replace inside maybe_unserialize/update_option lets WordPress
// re-serialize with correct byte counts — no manual byte arithmetic.
function _localdock_replace( $data, $from, $to ) {
    if ( is_array( $data ) ) {
        $out = [];
        foreach ( $data as $k => $v ) {
            $out[ is_string( $k ) ? str_replace( $from, $to, $k ) : $k ]
                = _localdock_replace( $v, $from, $to );
        }
        return $out;
    }
    if ( is_object( $data ) ) {
        foreach ( get_object_vars( $data ) as $prop => $val ) {
            $data->$prop = _localdock_replace( $val, $from, $to );
        }
        return $data;
    }
    if ( is_string( $data ) ) {
        return str_replace( $from, $to, $data );
    }
    return $data;
}

// Deactivate asset-optimization and caching plugins so WordPress falls back to
// serving individual CSS/JS files. Missing uploads (UAG CSS, Hummingbird bundles,
// etc.) are then proxied to the live server via uploads/.htaccess.
add_filter( 'option_active_plugins', function ( $plugins ) {
    $disable = [
        'hummingbird-performance/hummingbird-performance.php',
        'wp-hummingbird/wp-hummingbird.php',
        'litespeed-cache/litespeed-cache.php',
        'wp-rocket/wp-rocket.php',
        'w3-total-cache/w3-total-cache.php',
        'wp-super-cache/wp-cache.php',
        'wp-fastest-cache/wpFastestCache.php',
        'autoptimize/autoptimize.php',
        'sg-cachepress/sg-cachepress.php',
        'breeze/breeze.php',
        'cache-enabler/cache-enabler.php',
        'comet-cache/comet-cache.php',
    ];
    return array_values( array_diff( (array) $plugins, $disable ) );
} );
`;
    await fs.writeFile(pluginPath, content, 'utf-8');
    logger.info(`[DockerManager] Wrote dev-env plugin at ${pluginPath}`);
  }

  /**
   * Delete plugin-generated CSS cache files that were pulled from production.
   * Astra, Spectra/UAG, and Hummingbird compile settings from wp_options into CSS
   * files stored under uploads/. If those stale files are present, WordPress serves
   * them instead of regenerating from the freshly-imported local DB settings.
   * Deleting them here forces regeneration on first page load.
   */
  async clearThemeCssCache(localPath: string): Promise<void> {
    const cacheDirs = [
      path.join(localPath, 'wp-content', 'uploads', 'astra'),
      path.join(localPath, 'wp-content', 'uploads', 'uag-plugin'),
      path.join(localPath, 'wp-content', 'uploads', 'hummingbird-assets'),
    ];

    for (const dir of cacheDirs) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        await Promise.all(
          entries
            .filter(e => e.isFile())
            .map(e => fs.unlink(path.join(dir, e.name)).catch(() => {}))
        );
        logger.info(`[DockerManager] Cleared theme CSS cache: ${path.basename(dir)}`);
      } catch {
        // Directory doesn't exist — nothing to clear
      }
    }
  }

  /**
   * Write wp-content/mu-plugins/localdock-mail.php so WordPress routes all
   * outgoing email through Mailpit instead of a real mail server.
   * Idempotent — skipped if the file already exists.
   */
  async scaffoldMailPlugin(localPath: string): Promise<void> {
    const muPluginsDir = path.join(localPath, 'wp-content', 'mu-plugins');
    const pluginPath = path.join(muPluginsDir, 'localdock-mail.php');

    await fs.mkdir(muPluginsDir, { recursive: true });

    try {
      await fs.access(pluginPath);
      return;
    } catch {
      // doesn't exist yet
    }

    const content = `<?php
/**
 * LocalDock: Route WordPress mail through Mailpit.
 * Auto-generated — do not edit. Not pushed to production.
 */
add_action( 'phpmailer_init', function ( $phpmailer ) {
    $phpmailer->isSMTP();
    $phpmailer->Host     = 'mailpit';
    $phpmailer->Port     = 1025;
    $phpmailer->SMTPAuth = false;
} );
`;
    await fs.writeFile(pluginPath, content, 'utf-8');
    logger.info(`[DockerManager] Wrote Mailpit plugin at ${pluginPath}`);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildComposeTemplate(port: number, dbName: string, safeVolumeName: string): string {
    const mailPort = port + 1;
    const adminerPort = port + 2;
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
      - .:/var/www/html
    depends_on:
      db:
        condition: service_healthy
      mailpit:
        condition: service_started
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
      - ./.localdock/db.sql:/docker-entrypoint-initdb.d/db.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "mysql -uwordpress -pwordpress wordpress -e 'SHOW TABLES' 2>/dev/null | grep -q 'localdock_ready'"]
      interval: 5s
      timeout: 15s
      retries: 60
      start_period: 60s
    restart: unless-stopped

  mailpit:
    image: axllent/mailpit:latest
    ports:
      - "${mailPort}:8025"
    restart: unless-stopped

  adminer:
    image: adminer:latest
    ports:
      - "${adminerPort}:8080"
    environment:
      ADMINER_DEFAULT_SERVER: db
    depends_on:
      - db
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
            used.add(manifest.localPort + 1);
            used.add(manifest.localPort + 2);
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
