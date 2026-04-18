# LocalDock Gap Analysis & P0/P1 Implementation Plan

**Goal:** Identify what's done, what's broken, and what's missing compared to LocalWP-for-Flywheel parity, then implement the blocking and near-blocking issues.

**Architecture:** VS Code/Cursor extension (TypeScript/esbuild) with four tree views (Servers, Sites, Activity, Local Environments). Site operations communicate with cPanel over HTTPS API + SSH/SFTP. Local environments run in Docker Compose via `wordpress:latest` + `mysql:8.0`, with files mounted from the pulled site directory.

**Tech Stack:** TypeScript 5.6, esbuild, VS Code Extension API 1.85, ssh2 / ssh2-sftp-client, axios, Docker Compose CLI.

---

## State of the Project

### ✅ Complete and working
| Feature | Files |
|---|---|
| cPanel server management (add/edit/remove/test) | `commands/addServer.ts`, `editServer.ts`, `removeServer.ts`, `testConnection.ts` |
| WordPress site auto-detection (SSH + API fallback) | `api/CpanelClient.ts`, `tree/SiteTreeProvider.ts` |
| File pull from server (concurrent SFTP, MD5 manifest) | `sync/FileSyncer.ts`, `commands/pullSite.ts` |
| File push to server (diff-only, add/modify/delete) | `sync/FileSyncer.ts`, `commands/pushSite.ts` |
| Database pull (mysqldump over SSH, stored as db.sql) | `sync/DatabaseSyncer.ts` |
| Database push with URL rewrite localhost→production | `sync/DatabaseSyncer.ts` |
| Local Docker environment (start/stop/status, port assignment) | `docker/DockerManager.ts`, `commands/startLocal.ts` |
| wp-config.php patching (DB creds + WP_HOME/SITEURL) | `docker/DockerManager.ts::patchWpConfig` |
| Uploads proxy .htaccess (missing images → production) | `docker/DockerManager.ts::scaffoldUploadsProxy` |
| Pull uploads option (configurable, default off) | `utils/configManager.ts`, `commands/pullSite.ts` |
| Push exclude patterns (uploads NOT excluded so new images push) | `utils/configManager.ts`, `commands/pushSite.ts` |
| Remote diff check (what changed on server since last pull) | `commands/checkRemoteDiff.ts` |
| Local diff view (what you changed locally) | `commands/diffSite.ts` |
| Activity tree (progress, cancellation) | `ActivityManager.ts`, `tree/ActivityTreeProvider.ts` |
| Credential management (VS Code SecretStorage) | `auth/CredentialManager.ts` |

### ❌ Broken (blocking usability)

#### B1 — CSS not loading on local site
**Root cause:** The production `.htaccess` (copied verbatim during pull) typically contains HTTPS-redirect rules:
```apache
RewriteCond %{HTTPS} off
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
```
The local Docker container serves HTTP only. Apache applies the redirect, so every CSS/JS request gets 301'd to `https://localhost:PORT` which doesn't exist. The uploads proxy works because `scaffoldUploadsProxy` **replaces** that directory's `.htaccess` entirely. The root `.htaccess` is never touched.

**Fix:** Add `DockerManager::sanitizeRootHtaccess(localPath)` called from `startLocal` that strips HTTPS-redirect and canonical-domain rewrite rules from the WordPress root `.htaccess`, leaving the standard WP permalink block intact.

#### B2 — Push doesn't create missing remote directories
**Root cause:** `FileSyncer::uploadChanged` calls `sftp.fastPut(localPath, remotePath)` but never creates the remote parent directory. If a new file is in a subdirectory that doesn't exist on the server (e.g., a new plugin), the upload silently fails with a warning log.

**Fix:** Before `fastPut` for each upload, call `sftp.mkdir(remoteDir, { recursive: true })` (or the ssh2-sftp-client equivalent `sftp.client.mkdir`).

#### B3 — `diffSite` uses pull-side exclude patterns, not push-side
**Root cause:** `commands/diffSite.ts:34` passes `configManager.excludePatterns` to `DiffEngine.computeLocalChanges`. This excludes `wp-content/uploads/**`, so the "Show Changed Files" command hides newly uploaded images — yet push WOULD send them. The UI is lying.

**Fix:** Change `diffSite.ts` to use `configManager.pushExcludePatterns`.

---

### 🔶 Missing — P1 (core feature parity with LocalWP)

#### M1 — No email capture
LocalWP includes MailHog so emails sent by WordPress (password resets, WooCommerce orders, etc.) are caught locally instead of going to real addresses. Without this, developers either send real emails during testing or have to disable email entirely.

**Fix:** Add `mailpit` service to the Docker Compose template. Mailpit catches all outgoing SMTP and provides a web UI at `http://localhost:PORT+1`. Add a `WORDPRESS_CONFIG_EXTRA` env var (or patch wp-config.php) to set `SMTP_HOST=mailpit` and `SMTP_PORT=1025`. Expose the Mailpit web UI port and add an `openMailpit` command.

#### M2 — No database browser
LocalWP includes Adminer (a single-file PHP DB admin). Developers need to inspect/edit the DB directly, especially after a pull.

**Fix:** Add `adminer` service to the Docker Compose template on `PORT+2`. Add an `openAdminer` command that opens `http://localhost:PORT+2`.

#### M3 — No WP-CLI
LocalWP supports running WP-CLI commands against the local site. Useful for flushing caches, updating options, running migrations.

**Fix:** The `wordpress:latest` image ships with WP-CLI available. Add a `runWpCli` command that runs `docker compose exec wordpress wp <args>` and streams output to a VS Code terminal.

---

### 🔷 Missing — P2 (nice to have, not blocking)

| Feature | Notes |
|---|---|
| SSL for local dev (https://localhost) | Requires mkcert + nginx reverse proxy or Caddy in compose |
| Live links / tunnel | Expose local site via ngrok or Cloudflare tunnel |
| PHP version switching | Use `wordpress:php8.2-apache` etc. variants; needs compose rebuild |
| Site import from zip/backup | Unzip into localPath, import DB, run startLocal |
| Blueprints (template sites) | Save a pulled site as a reusable starting point |
| Xdebug support | Add xdebug PHP extension to a custom Docker image |

---

## Implementation Tasks

### Task 1 — Fix CSS (B1): Sanitize root .htaccess on startLocal

**Files:**
- Modify: `src/docker/DockerManager.ts`
- Modify: `src/commands/startLocal.ts`

**Steps:**
- [ ] Add `sanitizeRootHtaccess(localPath: string): Promise<void>` to `DockerManager`
- [ ] Strip lines matching HTTPS redirects and canonical-domain redirects:
  ```typescript
  async sanitizeRootHtaccess(localPath: string): Promise<void> {
    const htaccessPath = path.join(localPath, '.htaccess');
    let content: string;
    try {
      content = await fs.readFile(htaccessPath, 'utf-8');
    } catch {
      return; // no .htaccess, nothing to do
    }

    const STRIP_PATTERNS = [
      /^\s*RewriteCond\s+%\{HTTPS\}\s+off.*$/im,
      /^\s*RewriteCond\s+%\{HTTP_HOST\}\s+!\^.*$/im,
      /^\s*RewriteRule\s+\^.*https?:\/\/%\{HTTP_HOST\}.*\[R=30[12],L\].*$/im,
      /^\s*RewriteRule\s+\^.*https:\/\/.*\[R=30[12],L\].*$/im,
    ];

    let sanitized = content;
    for (const pattern of STRIP_PATTERNS) {
      sanitized = sanitized.replace(pattern, '');
    }

    if (sanitized !== content) {
      await fs.writeFile(htaccessPath, sanitized, 'utf-8');
      logger.info(`[DockerManager] Sanitized root .htaccess for ${localPath}`);
    }
  }
  ```
- [ ] Call it in `startLocal.ts` after `scaffoldUploadsProxy` and before `start`:
  ```typescript
  activityManager.update(opId, 45, 'Patching .htaccess for local HTTP…');
  await dockerManager.sanitizeRootHtaccess(site.localPath);
  ```
- [ ] Run `npm run build` — confirm `[esbuild] Build complete`
- [ ] Commit

### Task 2 — Fix push silent failures (B2): Create remote directories before upload

**Files:**
- Modify: `src/sync/FileSyncer.ts`

**Steps:**
- [ ] In `uploadChanged`, before `fastPut`, ensure the remote parent directory exists:
  ```typescript
  const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
  await this.sftp.mkdir(remoteDir).catch(() => {}); // no-op if already exists
  ```
- [ ] Check `SftpClient` to confirm `mkdir` signature (ssh2-sftp-client: `sftp.mkdir(path, recursive?)`)
- [ ] Run `npm run build` — confirm clean
- [ ] Commit

### Task 3 — Fix diffSite consistency (B3)

**Files:**
- Modify: `src/commands/diffSite.ts`

**Steps:**
- [ ] Change line 34 from `configManager.excludePatterns` to `configManager.pushExcludePatterns`
- [ ] Run `npm run build` — confirm clean
- [ ] Commit

### Task 4 — Add Mailpit email capture (M1)

**Files:**
- Modify: `src/docker/DockerManager.ts` — update `buildComposeTemplate`
- Modify: `src/extension.ts` — register `openMailpit` command
- Modify: `package.json` — add command contribution
- Modify: `src/tree/LocalDockerTreeProvider.ts` — add Mailpit URL to tooltip/description

**Steps:**
- [ ] Add `mailpit` service to compose template:
  ```yaml
    mailpit:
      image: axllent/mailpit:latest
      ports:
        - "${mailPort}:8025"
      restart: unless-stopped
  ```
  where `mailPort = port + 1`
- [ ] Add `WORDPRESS_CONFIG_EXTRA` env to `wordpress` service:
  ```yaml
      WORDPRESS_CONFIG_EXTRA: |
        define('SMTP_HOST', 'mailpit');
        define('SMTP_PORT', 1025);
  ```
  Note: WP core doesn't use these constants directly; add WP Mail SMTP config or use `wp_mail` filter. Simplest: add `wp-content/mu-plugins/localdock-mail.php` that configures `phpmailer` to use mailpit via the `phpmailer_init` action. Scaffold this file from `DockerManager` on first start.
- [ ] Add `scaffoldMailPlugin(localPath)` to `DockerManager` that writes the mu-plugin file if it doesn't exist
- [ ] Add `openMailpit` command to `extension.ts` that opens `http://localhost:${port+1}`
- [ ] Add to `package.json` commands array
- [ ] Add Mailpit URL to `LocalDockerTreeProvider` description when running
- [ ] Run `npm run build` — confirm clean
- [ ] Commit

### Task 5 — Add Adminer database browser (M2)

**Files:**
- Modify: `src/docker/DockerManager.ts` — update `buildComposeTemplate`
- Modify: `src/extension.ts` — register `openAdminer` command
- Modify: `package.json` — add command contribution

**Steps:**
- [ ] Add `adminer` service to compose template on `port + 2`:
  ```yaml
    adminer:
      image: adminer:latest
      ports:
        - "${adminerPort}:8080"
      depends_on:
        - db
      restart: unless-stopped
  ```
- [ ] Update `buildComposeTemplate` signature to accept `mailPort` and `adminerPort` params (= `port + 1` and `port + 2`)
- [ ] Update call site in `startLocal.ts` (or derive ports inside `buildComposeTemplate`)
- [ ] Register `openAdminer` command in `extension.ts`
- [ ] Add to `package.json` commands array
- [ ] Run `npm run build` — confirm clean
- [ ] Commit

---

## Priority Order

```
B1 (CSS)       ← do first, it's blocking every test
B2 (push dirs) ← do second, silent data loss on push
B3 (diff UI)   ← quick fix, 5 minutes
M1 (Mailpit)   ← meaningful feature, ~1 hour
M2 (Adminer)   ← meaningful feature, ~30 minutes
M3 (WP-CLI)    ← useful, ~45 minutes
```

After B1–B3 and M1–M2 are done, the extension reaches functional parity with LocalWP's core workflow: pull → develop → test emails → inspect DB → push.
