# LocalWP for cPanel

> **Work in Progress** — Core pull/push workflows are functional and being tested. Docker-based local WordPress environments are implemented but not yet end-to-end tested. Not yet published to the Marketplace.

A Cursor / VS Code extension that replicates the [LocalWP](https://localwp.com/) workflow for WordPress sites hosted on cPanel/WHM servers. Log in once, browse all your WordPress installs in the sidebar, pull a full copy locally, spin up a local WordPress environment with Docker, edit in Cursor, and push changes back — all without leaving the editor.

---

## What Works Today

### Server Management
- Add a cPanel server (host, username, password or SSH key)
- Edit an existing server's connection details or credentials
- Remove a server
- Test connection — verifies cPanel HTTPS API access and optionally SSH

### WordPress Site Discovery
- Automatically lists all WordPress installs on a server when you connect
- Detection uses cPanel HTTPS API (Fileman) to read `wp-config.php` — SSH is not required for discovery
- Falls back to SSH-based detection if the API path fails
- Sites listed alphabetically

### Pull (Download)
- Right-click any site → **Pull Site** to download all WordPress files via SFTP
- Exports the remote database via `mysqldump` over SSH, downloads it, and imports it into your local MySQL instance
- Handles `DB_HOST` values like `localhost:3306` in wp-config.php correctly (splits host and port)
- Excludes large/unnecessary directories by default (`wp-content/uploads`, `wp-content/cache`, `node_modules`, etc.)
- Writes a `.localwp/manifest.json` with file checksums for diff-based push later
- Cancellable mid-transfer via the Activity panel
- After pull completes, prompts to start a local Docker environment immediately

### Push (Upload)
- Right-click a pulled site → **Push Site**
- Computes a diff against the manifest (added / modified / deleted files)
- Shows a QuickPick confirmation list of every file that will change before doing anything
- Uploads only changed files concurrently via SFTP
- Exports local DB and imports it on the remote server
- Updates the manifest with new checksums

### Diff (Show Changes)
- Right-click → **Show Changed Files** to preview local changes without pushing

### Open Site Folder
- Right-click → **Open Site Folder** to reveal the local site directory in the OS file explorer

### Local Docker Environments *(implemented, testing in progress)*
- Right-click a pulled site → **Start Local WordPress** to spin up a WordPress + MySQL stack via Docker Compose
- Automatically scaffolds a `docker-compose.yml` in `.localwp/` — customizable, never overwritten once created
- Rewrites WordPress `siteurl`/`home` options in the SQL dump from production URL to `http://localhost:{port}` before first start
- Patches `wp-config.php` to use Docker MySQL credentials (backup saved to `.localwp/wp-config.docker.bak`)
- Assigns a unique port per site starting from 8080 (configurable), checked against both OS availability and other sites' manifests
- **Stop Local** button tears down containers; **Open in Browser** opens the site in Cursor's built-in Simple Browser panel
- Graceful error when Docker Desktop is not installed — shows link to download page

### Activity Panel
- Live progress display for any running pull, push, or local environment operation
- History of completed, failed, and cancelled operations with duration
- Cancel button on any running operation
- Stale states cleared automatically on extension restart

---

## Sidebar Layout

```
LOCALWP CPANEL
├── SERVERS
│   └── MyServer (host, right-click to test/edit/remove)
├── WORDPRESS SITES
│   ├── example.com    Pulled 2h ago  ▶ :8080
│   ├── mysite.org     Modified  ◼ Stopped
│   └── staging.net    Not pulled
├── ACTIVITY
│   ├── example.com  ↓ Pull 47% — Downloading files…
│   └── mysite.org   ✓ ↑ Push — 12s
└── LOCAL ENVIRONMENTS
    ├── [Docker Desktop v27.x.x]
    ├── example.com    ▶ Running — http://localhost:8080
    └── mysite.org     ◼ Stopped
```

---

## Setup Requirements

### VS Code / Cursor
- VS Code 1.85+ or any recent Cursor build

### On your local machine
- **MySQL** running locally (default: `127.0.0.1:3306`, user `root`) — required for DB import during pull/push
- **Docker Desktop** — required for local WordPress environments (optional if you only need pull/push)
- **SSH access** to your cPanel server is required for Pull and Push
- SSH is not needed for site discovery — that uses cPanel HTTPS port 2083

### On your cPanel server
- cPanel/WHM with UAPI access enabled
- `mysqldump` available (standard on most cPanel hosts)
- SSH enabled for your cPanel user

---

## Configuration

All settings are under `LocalWP for cPanel` in VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `localwpCpanel.localSitesDirectory` | `~/localwp-sites` | Where pulled sites are stored |
| `localwpCpanel.localMysqlHost` | `127.0.0.1` | Local MySQL host |
| `localwpCpanel.localMysqlPort` | `3306` | Local MySQL port |
| `localwpCpanel.localMysqlUser` | `root` | Local MySQL username |
| `localwpCpanel.sshPort` | `22` | Default SSH port for servers |
| `localwpCpanel.excludePatterns` | see below | Glob patterns excluded from sync |
| `localwpCpanel.databaseSyncMethod` | `mysqldump` | `mysqldump` or `wpcli` |
| `localwpCpanel.maxConcurrentTransfers` | `5` | Parallel SFTP file transfers |
| `localwpCpanel.rejectUnauthorizedSsl` | `false` | Reject self-signed SSL certs |
| `localwpCpanel.dockerStartPort` | `8080` | Starting port for local Docker environments |

Default exclude patterns:
```
wp-content/uploads/**
wp-content/cache/**
wp-content/backup-db/**
*.log
.DS_Store
node_modules/**
```

> **Tip:** Keep `wp-content/uploads/**` excluded unless you specifically need media files locally — syncing a large uploads folder will make pull/push very slow.

---

## How Local Docker Environments Work

When you click **Start Local WordPress** on a pulled site, the extension:

1. Checks Docker Desktop is installed and running
2. Assigns a unique local port (default starts at 8080)
3. Scaffolds `.localwp/docker-compose.yml` if it doesn't exist (safe to customize — never overwritten)
4. Rewrites the downloaded `db.sql` so WordPress URLs point to `http://localhost:{port}` instead of the live domain
5. Patches `wp-config.php` to use the Docker MySQL credentials
6. Runs `docker compose up -d` — MySQL seeded from `db.sql` on first start
7. Polls until containers are healthy, then opens the site in Cursor's browser panel

To stop: right-click → **Stop Local WordPress** (runs `docker compose down`).

The `docker-compose.yml` lives in `.localwp/` (not the site root) so it doesn't interfere with your WordPress source files.

---

## Security Notes

- Passwords and SSH keys are stored in VS Code's `SecretStorage` (OS keychain — Keychain on Mac, Credential Manager on Windows, libsecret on Linux). Never written to disk in plaintext.
- Database passwords in SSH commands use the `MYSQL_PWD` environment variable so they are not recorded in shell history.
- Remote temp files (SQL dumps) are always deleted in `finally` blocks.
- Local Docker MySQL credentials are intentionally simple (`wordpress`/`wordpress`) — this is a local dev environment only, never exposed externally.

---

## Known Issues / Incomplete Features

- **Docker local env — end-to-end testing in progress** — implemented but not fully validated across different site configurations
- **WP-CLI database sync method** — the `wpcli` option in settings is not yet implemented. Only `mysqldump` works.
- **Conflict detection** — if someone edits a file on the remote server after you pulled, the push currently overwrites without warning. Planned.
- **Media sync** — `wp-content/uploads` is excluded by default. No dedicated media sync command yet.
- **Windows local MySQL path** — if `mysql`/`mysqldump` are not on your PATH (common with XAMPP/WAMP), the DB import step will fail silently. Add your MySQL `bin` directory to PATH.
- **Push without a prior pull** — there is no mechanism to push to a site that was never pulled locally.
- **Extension packaging** — not yet published to the VS Code Marketplace. Install by running `npm run build` and pressing F5 to launch a development host.

---

## Project Structure

```
src/
├── extension.ts              # Activation, command registration, stale state reset
├── ActivityManager.ts        # Tracks live/completed operations
├── SiteRegistry.ts           # globalState persistence for servers and sites
├── api/
│   ├── CpanelClient.ts       # cPanel UAPI over HTTPS (site discovery, WP detection)
│   ├── SshClient.ts          # SSH command execution (ssh2)
│   └── SftpClient.ts         # SFTP file transfer with parallel directory walking
├── auth/
│   ├── CredentialManager.ts  # SecretStorage CRUD for passwords and SSH keys
│   └── AuthProvider.ts       # Connection test logic
├── commands/
│   ├── addServer.ts
│   ├── editServer.ts
│   ├── removeServer.ts
│   ├── testConnection.ts
│   ├── refreshSites.ts
│   ├── pullSite.ts           # Full pull orchestration + post-pull Docker prompt
│   ├── pushSite.ts           # Diff-based push orchestration
│   ├── diffSite.ts
│   ├── openSiteFolder.ts
│   ├── startLocal.ts         # Docker: port assign, scaffold, URL rewrite, compose up
│   ├── stopLocal.ts          # Docker: compose down
│   ├── openLocalSite.ts      # Opens localhost URL in Cursor Simple Browser
│   └── serverHelpers.ts
├── docker/
│   └── DockerManager.ts      # Docker CLI wrapper: scaffold, start, stop, status, ports
├── sync/
│   ├── FileSyncer.ts         # Concurrent SFTP download/upload with semaphore
│   ├── DatabaseSyncer.ts     # mysqldump export/import + URL rewrite for Docker
│   ├── DiffEngine.ts         # Checksum-based local change detection
│   └── Manifest.ts           # .localwp/manifest.json read/write
├── tree/
│   ├── ServerTreeProvider.ts
│   ├── SiteTreeProvider.ts
│   ├── SiteTreeItem.ts       # Icons/descriptions including local env status
│   ├── ActivityTreeProvider.ts
│   └── LocalDockerTreeProvider.ts  # 4th panel: Docker status + per-site env state
├── models/
│   ├── Server.ts
│   ├── Site.ts               # WordPressSite (includes localEnv state)
│   ├── SyncState.ts
│   ├── LocalEnvState.ts      # LocalEnvStatus + LocalEnvState interface
│   ├── Manifest.ts           # SiteManifest (includes localPort, dbUrlRewritten)
│   └── Credentials.ts
└── utils/
    ├── logger.ts
    ├── configManager.ts      # Typed getters for all settings incl. dockerStartPort
    ├── errors.ts             # LocalWPError + DOCKER_NOT_FOUND/START/STOP codes
    ├── pathUtils.ts
    └── progressUtils.ts
```

---

## Development

```bash
npm install
npm run build       # one-shot build via esbuild
npm run watch       # rebuild on save
```

Press **F5** in Cursor/VS Code to launch the Extension Development Host.

Bundled with [esbuild](https://esbuild.github.io/). `ssh2` and `ssh2-sftp-client` are marked as external (native bindings) and must be present in `node_modules` at runtime.
