# LocalDock for cPanel

A Cursor / VS Code extension that replicates the [LocalWP](https://localwp.com/) workflow for WordPress sites hosted on cPanel/WHM. Log in once, browse all your WordPress installs in the sidebar, pull a full copy locally, spin up a local WordPress environment in Docker, edit in Cursor, and push changes back — without leaving the editor.

> Distributed as an installable `.vsix` via [GitHub Releases](https://github.com/incompletebiped/cursor-extension-localdock/releases).

---

## Requirements

**Local machine**
- VS Code 1.85+ or any recent Cursor build
- Docker Desktop (required for local WordPress environments; not needed for pull/push only)
- MySQL running locally (default: `127.0.0.1:3306`, user `root`) — needed for DB import/export

**cPanel server**
- cPanel/WHM with UAPI (port 2083) accessible
- SSH enabled for your cPanel user
- `mysqldump` available (standard on all cPanel hosts)

---

## Installation

1. Download the latest `localdock-cpanel-<version>.vsix` from [**Releases**](https://github.com/incompletebiped/cursor-extension-localdock/releases)
2. In Cursor/VS Code: Extensions panel → **`…`** menu → **Install from VSIX…**
   - Or from a terminal: `cursor --install-extension localdock-cpanel-<version>.vsix`
3. Reload when prompted — the **LocalDock cPanel** icon appears in the activity bar

---

## Features

### Server & Site Management
- Add, edit, remove, and test cPanel servers
- WordPress sites discovered automatically on connect — uses cPanel Fileman API, SSH is not required for discovery
- Sites listed alphabetically with sync status and local environment state

### Pull (Download from server)
- Full WordPress files downloaded via concurrent SFTP
- `mysqldump` export over SSH, imported into your local MySQL
- MD5 manifest written for accurate diff-based push later
- Configurable exclude patterns (uploads excluded by default — large)
- Cancellable at any point via the Activity panel

### Push (Upload to server)
- Diff-only upload — only added, modified, and deleted files transfer
- Shows a file-by-file confirmation list before any changes are made
- Exports local MySQL DB, imports on remote, rewrites localhost URLs to production (PHP serialize-safe — preserves Astra/Elementor byte counts)
- Remote directories created automatically before upload

**How deletions are actually handled:**
- **A file you pulled, then deleted locally, *is* deleted on the remote when you push.** The diff compares your local folder against the manifest recorded at your last pull — anything the manifest knows about that's now missing from disk shows up as "will be deleted" in the push confirmation list, and is removed from the server via SFTP once you confirm.
- **A file that only ever existed on the remote (never pulled locally) is untouched by push either way.** The diff only knows about files it has seen locally, so something that exists solely on the server — added directly there, or uploaded out-of-band like the Companion Plugin's own files right after provisioning — can't appear as "deleted" no matter what your local folder looks like. It shows up locally the next time you actually pull, not before.
- **The database is never diffed — every push fully overwrites the remote database with your local one.** Local MySQL is dumped in full and imported over the remote database as-is, with no selective sync. This is why a database-only change (e.g. deactivating a plugin, which flips the `active_plugins` option) shows up remotely after a push even though no *file* changed — and, more importantly, why pushing after the remote database changed since your last pull silently overwrites those remote changes with your local snapshot. There's no confirmation step for this beyond the generic "database will be exported and pushed" line in the confirmation dialog; run **Check for Changes (Companion Plugin)** first if you need to know whether the remote DB has drifted since your last pull.

> **Deleting a plugin from your local site's wp-admin and getting an FTP-credentials prompt?** That's WordPress itself, running inside your local Docker container, failing its own filesystem-permission check before it'll delete a plugin folder — it has nothing to do with LocalDock's connection to your cPanel server. Delete the plugin's folder directly in your local site directory instead (Explorer / VS Code) and push as usual — it'll be picked up by the file-deletion diff described above.

### Local Docker Environment
- WordPress + MySQL 8 stack via Docker Compose, one environment per site
- Unique port assigned per site (default starts at 8080)
- `.htaccess` HTTPS-redirect rules stripped automatically so local HTTP works
- `wp-config.php` patched for Docker DB credentials; backup saved to `.localdock/`
- **Mailpit** email capture at `http://localhost:PORT+1` — all `wp_mail()` caught locally
- **Adminer** database browser at `http://localhost:PORT+2`
- **Open in Browser** opens the site in Cursor's Simple Browser panel

### Diff & Inspect
- **Show Changed Files** — preview local changes against the last pull manifest
- **Check Remote for Changes** — see what changed on the server since you pulled

### LocalDock Companion (drift detection plugin)
- A small WordPress plugin (`wordpress-plugin/localdock-companion/`) you provision per site, hooking into WP's native change events (`save_post`, `updated_option`, `activated_plugin`, `switch_theme`, `add_attachment`, `wp_update_user`) instead of requiring a brute-force hash walk to detect drift
- **Provision Companion Plugin** — uploads the plugin over SFTP, activates it via `wp-cli` when available, and reads back its generated API key, storing it in `SecretStorage`; falls back to a manual key-entry prompt if automatic activation or key retrieval fails
- **Check for Changes (Companion Plugin)** — queries the plugin's read-only REST endpoint (`/wp-json/localdock/v1/changes`) for everything that happened on the live site since your last pull, listed by object (post, option, plugin, theme, user) with a one-click "Pull now"
- Per-site status (plugin active/inactive/not installed, key valid/invalid) surfaces in the sidebar tooltip so a silently-deactivated plugin doesn't go unnoticed
- After a pull, LocalDock offers to set up the Companion plugin if it isn't active yet

### Activity Panel
- Live progress for all running operations
- Cancel button on any running pull, push, or Docker operation
- History of completed, failed, and cancelled operations

---

## Sidebar Layout

```
LOCALDOCK CPANEL
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

Hover a site for its full status, including Companion Plugin state (active/inactive/not installed) and API key validity. A site not yet pulled shows an inline **Pull** icon; once it's been pulled, that becomes an inline **Push** icon so uploading back doesn't require a right-click either. A site without an active Companion Plugin shows a one-click **Provision Companion Plugin** icon inline in the sidebar row too. Right-click any site for the full command set (Pull, Push, Show Changed Files, Check Remote for Changes, Provision/Check Companion Plugin). Start Local and its inline sidebar button stay disabled until a site has actually been pulled — a single `getPullBucket()` check (`needed` / `busy` / `ready`) drives the Pull/Push/Start Local button visibility and each command's own guard, so they can't disagree.

---

## Configuration

All settings live under `localdockCpanel.*`:

| Setting | Default | Description |
|---------|---------|-------------|
| `localSitesDirectory` | `~/localdock-sites` | Where pulled sites are stored |
| `localMysqlHost` | `127.0.0.1` | Local MySQL host |
| `localMysqlPort` | `3306` | Local MySQL port |
| `localMysqlUser` | `root` | Local MySQL username |
| `sshPort` | `22` | Default SSH port |
| `rejectUnauthorizedSsl` | `true` | Verify SSL certificates on cPanel API calls. Disable only for servers with self-signed certificates. |
| `pullUploads` | `false` | Download `wp-content/uploads` on pull |
| `uploadsSyncPaths` | UAG, Elementor, Hummingbird, Astra… | Upload subdirs always synced even when `pullUploads` is false |
| `excludePatterns` | cache, logs, node_modules… | Paths excluded from pull |
| `databaseSyncMethod` | `mysqldump` | `mysqldump` (default) |
| `maxConcurrentTransfers` | `20` | Parallel SFTP file transfers (pipelined over one SSH connection, not one per file — lower it if a host rate-limits SFTP activity) |
| `dockerStartPort` | `8080` | First port checked when assigning a local environment |

If a pull/push feels slow on a site with lots of small files (plugins, themes, uploads), raise `localdockCpanel.maxConcurrentTransfers` in Cursor/VS Code settings — per-file round-trip latency, not bandwidth, dominates on those sites, and this setting is what hides it. It's safe to go well above the default of 20 since transfers are pipelined over one SSH connection rather than opened per file; only lower it if the host starts rate-limiting SFTP.

---

## Security

- cPanel passwords and SSH keys are stored in VS Code `SecretStorage` (OS keychain — Keychain on macOS, Credential Manager on Windows, libsecret on Linux). Never written to disk.
- WordPress database passwords are also stored in `SecretStorage` — stripped from the site registry before it is persisted to disk.
- `mysqldump` / `mysql` commands pass credentials via the `MYSQL_PWD` environment variable, not as CLI flags, so they do not appear in shell history or process listings.
- TLS certificate validation is **on by default** for all cPanel HTTPS API connections.
- SSH host keys are pinned on trust-on-first-use: the first successful connection to a server records its host key fingerprint (SHA256), and every later connection must present the same key. A mismatch refuses the connection instead of silently proceeding — run **Test Connection** on that server to review it and explicitly trust the new key if you've verified the change is legitimate (e.g. the server was migrated).
- Remote temp files (SQL dumps, PHP scripts) are always deleted in `finally` blocks.
- Database credentials (`DB_HOST`, `DB_USER`, `DB_NAME`) read from a site's `wp-config.php` are validated against a strict allow-list before ever being used in a shell command, since they originate from a file inside the WordPress webroot.

---

## Known Limitations

| Area | Status |
|---|---|
| WP-CLI sync method | The `wpcli` setting option is not yet implemented. Only `mysqldump` works. |
| File conflict detection | If a file is edited on the server after you pulled, push overwrites it without warning. |
| Database push is a full overwrite | Push doesn't diff the database — it replaces the entire remote database with your local dump on every push. If the remote DB changed since your last pull (e.g. a live edit, an order, a comment), pushing silently discards it. Check for drift with **Check for Changes (Companion Plugin)** before pushing if that matters. |
| Push without prior pull | A site must be pulled before it can be pushed. |
| Windows PATH (MySQL) | If `mysql`/`mysqldump` are not on your system PATH (common with XAMPP/WAMP), DB sync will fail. Add your MySQL `bin` directory to PATH. |
| Marketplace | Not yet published to the VS Code Marketplace. Install via `.vsix` from Releases. |
| Companion plugin distribution | Not on WP.org — provisioned by LocalDock itself or installed manually from `wordpress-plugin/localdock-companion/`. Untested against a real WordPress install so far. |
| Companion plugin automatic activation | Tries `wp-cli` first, then falls back to a direct PHP CLI activation if `wp-cli` isn't reachable over SSH. If both fail (e.g. PHP CLI itself unavailable), the plugin uploads but stays inactive until you activate it manually in wp-admin, then re-run "Provision Companion Plugin" to pick up the key. |
| Companion plugin coverage | Only catches changes made through WordPress itself (hooks like `save_post`, `updated_option`). Files edited directly via SFTP/FTP outside WordPress aren't detected yet. |

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full feature timeline.

**Up next (v0.2):** WP-CLI terminal, PHP version switching, Xdebug support, Companion plugin hardening (real-world testing, file-level change detection).

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
│   ├── SftpClient.ts         # SFTP file transfer with parallel directory walking
│   └── CompanionPluginClient.ts  # REST probe + polling for the Companion plugin's changelog endpoint
├── auth/
│   ├── CredentialManager.ts  # SecretStorage CRUD for server creds, DB passwords, Companion API keys
│   └── AuthProvider.ts       # Connection test logic
├── commands/
│   ├── pullSite.ts           # Full pull orchestration
│   ├── pushSite.ts           # Diff-based push orchestration
│   ├── startLocal.ts         # Docker: port assign, scaffold, URL rewrite, compose up
│   ├── stopLocal.ts          # Docker: compose down
│   ├── provisionCompanionPlugin.ts  # Upload/activate the Companion plugin, store its API key
│   ├── checkCompanionDrift.ts       # Poll the Companion plugin for changes since last pull
│   └── ...                   # addServer, editServer, removeServer, diffSite, etc.
├── companion/
│   ├── CompanionProvisioner.ts       # SFTP upload + wp-cli activation + DB key readback
│   └── companionPluginFiles.generated.ts  # Bundled plugin source, generated by scripts/generate-companion-plugin-source.js
├── docker/
│   └── DockerManager.ts      # Docker CLI wrapper: scaffold, start, stop, status
├── sync/
│   ├── FileSyncer.ts         # Concurrent SFTP download/upload
│   ├── DatabaseSyncer.ts     # mysqldump export/import + URL rewrite
│   ├── DiffEngine.ts         # Checksum-based local change detection
│   └── Manifest.ts           # .localdock/manifest.json read/write
├── tree/                     # Four sidebar panel providers
├── models/                   # TypeScript interfaces (Server, Site, SyncState, CompanionPlugin, etc.)
└── utils/                    # logger, configManager, errors, pathUtils, siteStatus (pull-state gating)

wordpress-plugin/
└── localdock-companion/      # The Companion WP plugin itself — separate artifact, not bundled into the .vsix

docs/
└── localdock-companion-design-notes.md  # Design rationale for the Companion plugin

scripts/
└── generate-companion-plugin-source.js  # Bundles wordpress-plugin/ into src/companion/companionPluginFiles.generated.ts
```

## Development

```bash
npm install
npm run build              # one-shot esbuild
npm run watch               # rebuild on save
npm run generate:companion  # regenerate companionPluginFiles.generated.ts after editing wordpress-plugin/
```

Press **F5** to launch the Extension Development Host.
