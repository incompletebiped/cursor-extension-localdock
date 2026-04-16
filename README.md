# LocalWP for cPanel

> **Work in Progress** — This extension is functional for core pull/push workflows but is not yet published or considered stable. Features marked below as incomplete have not been tested end-to-end.

A Cursor / VS Code extension that replicates the [LocalWP](https://localwp.com/) workflow for WordPress sites hosted on cPanel/WHM servers. Log in once, browse all your WordPress installs in the sidebar, pull a full copy locally, edit in Cursor, and push changes back — all without leaving the editor.

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
- Sites listed alphabetically; server label no longer duplicated in the WordPress Sites panel

### Pull (Download)
- Right-click any site → **Pull Site** to download all WordPress files via SFTP
- Exports the remote database via `mysqldump` over SSH, downloads it locally, and imports it into your local MySQL instance
- Excludes large/unnecessary directories by default (`wp-content/uploads`, `wp-content/cache`, `node_modules`, etc.)
- Writes a `.localwp/manifest.json` with file checksums for diff-based push later
- Cancellable mid-transfer via the Activity panel

### Activity Panel (third sidebar section)
- Live progress display for any running pull or push (spinner, percentage, current step)
- History of completed, failed, and cancelled operations with duration
- Cancel button on any running operation
- Stale "Pulling..." / "Pushing..." states are cleared automatically on extension restart — no more stuck progress indicators after a Cursor reload

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

---

## Sidebar Layout

```
LOCALWP CPANEL
├── SERVERS
│   └── MyServer (host, right-click to test/edit/remove)
├── WORDPRESS SITES
│   ├── example.com    [pulled]
│   ├── mysite.org     [modified]
│   └── staging.net    [not pulled]
└── ACTIVITY
    ├── example.com  ↓ Pull 47% — Downloading files… (47 / 100)
    └── mysite.org   ✓ ↑ Push — 12s
```

---

## Setup Requirements

### VS Code / Cursor
- VS Code 1.85+ or any recent Cursor build

### On your local machine
- **MySQL** running locally (default: `127.0.0.1:3306`, user `root`)
- **SSH access** to your cPanel server is required for Pull and Push (file transfer + database export/import)
- SSH does not need to be open for site discovery — that uses cPanel HTTPS port 2083

### On your cPanel server
- cPanel/WHM with UAPI access enabled
- `mysqldump` available (standard on most cPanel hosts)
- SSH enabled for your cPanel user (required for Pull/Push, not for browsing)

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

Default exclude patterns:
```
wp-content/uploads/**
wp-content/cache/**
wp-content/backup-db/**
*.log
.DS_Store
node_modules/**
```

> **Tip:** Keep `wp-content/uploads/**` excluded unless you specifically need media files locally — uploading a large uploads folder will make pull/push very slow.

---

## Security Notes

- Passwords and SSH keys are stored in VS Code's `SecretStorage` (OS keychain — Keychain on Mac, Credential Manager on Windows, libsecret on Linux). They are never written to disk in plaintext.
- Database passwords in SSH commands use the `MYSQL_PWD` environment variable inline so they are not recorded in shell history.
- Remote temp files (SQL dumps) are always deleted in `finally` blocks.

---

## Known Issues / Incomplete Features

- **WP-CLI database sync method** — the `wpcli` option in settings is not yet implemented. Only `mysqldump` works.
- **Conflict detection** — if someone edits a file on the remote server after you pulled, the push currently overwrites without warning. Conflict detection is planned.
- **Media sync** — `wp-content/uploads` is excluded by default. There is no dedicated media sync command yet.
- **Multi-server parallel operations** — pulling two sites simultaneously from different servers is untested.
- **Windows local MySQL path** — the local DB import uses the `mysql` CLI. If `mysql` is not on your PATH (common with XAMPP/WAMP installs), the import step will fail silently. Add your MySQL `bin` directory to PATH to fix this.
- **Push without a prior pull** — there is no mechanism to push to a site that was never pulled locally.
- **Extension packaging** — not yet published to the VS Code Marketplace. Install by running `npm run build` and pressing F5 in Cursor to launch a development host.

---

## Project Structure

```
src/
├── extension.ts              # Activation, command registration, stale state reset
├── ActivityManager.ts        # Tracks live/completed pull+push operations
├── SiteRegistry.ts           # globalState persistence for servers and sites
├── api/
│   ├── CpanelClient.ts       # cPanel UAPI over HTTPS (site discovery, WP detection)
│   ├── SshClient.ts          # SSH command execution (ssh2)
│   └── SftpClient.ts         # SFTP file transfer with parallel directory walking
├── auth/
│   ├── CredentialManager.ts  # SecretStorage CRUD for passwords and SSH keys
│   └── AuthProvider.ts       # Connection test logic
├── commands/
│   ├── addServer.ts          # Add cPanel server wizard
│   ├── editServer.ts         # Edit existing server
│   ├── removeServer.ts
│   ├── testConnection.ts
│   ├── refreshSites.ts
│   ├── pullSite.ts           # Full pull orchestration
│   ├── pushSite.ts           # Diff-based push orchestration
│   ├── diffSite.ts           # Show local changes
│   ├── openSiteFolder.ts
│   └── serverHelpers.ts      # Shared: hostname normalization, credential prompts
├── sync/
│   ├── FileSyncer.ts         # Concurrent SFTP download/upload with semaphore
│   ├── DatabaseSyncer.ts     # mysqldump export/import over SSH
│   ├── DiffEngine.ts         # Checksum-based local change detection
│   └── Manifest.ts           # .localwp/manifest.json read/write
├── tree/
│   ├── ServerTreeProvider.ts
│   ├── SiteTreeProvider.ts
│   ├── SiteTreeItem.ts
│   └── ActivityTreeProvider.ts  # Running ops + history in Activity panel
├── models/
│   ├── Server.ts             # CpanelServer interface
│   ├── Site.ts               # WordPressSite interface
│   ├── SyncState.ts          # SyncStatus state machine
│   ├── Manifest.ts           # SiteManifest schema
│   └── Credentials.ts        # StoredCredentials (SecretStorage only)
└── utils/
    ├── logger.ts             # OutputChannel with log levels
    ├── configManager.ts      # Typed getters for all settings
    ├── errors.ts             # handleError + LocalWPError hierarchy
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

Press **F5** in Cursor/VS Code to launch the Extension Development Host with the extension loaded.

Bundled with [esbuild](https://esbuild.github.io/). `ssh2` and `ssh2-sftp-client` are marked as external (native bindings cannot be bundled) and must be present in `node_modules` at runtime.
