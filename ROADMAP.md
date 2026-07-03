# LocalDock for cPanel — Roadmap

## v0.1.x — Foundation (current)

### Shipped in v0.1.0
- cPanel server management (add / edit / remove / test connection)
- WordPress site auto-detection via SSH + cPanel HTTPS API fallback
- File pull from server (concurrent SFTP, MD5 manifest for change tracking)
- File push to server (diff-only — added, modified, deleted)
- Database pull via `mysqldump` over SSH
- Database push with localhost → production URL rewrite (PHP serialize-safe)
- Local Docker environment (WordPress + MySQL 8) with automatic port assignment
- `wp-config.php` patching for local DB credentials and `WP_HOME`/`SITEURL`
- Uploads proxy `.htaccess` so missing images fall through to production
- `.htaccess` HTTPS-redirect sanitization so local HTTP works correctly
- Remote directory creation before file upload (fixes silent push failures)
- Mailpit email capture — all outgoing WordPress mail caught locally, web UI on `PORT+1`
- Adminer database browser on `PORT+2`
- Remote diff check (what changed on the server since last pull)
- Local diff view (what you changed locally vs. last pull)
- Activity tree with progress reporting and cancellation
- Credentials stored in VS Code SecretStorage (OS keychain)
- Configurable exclude/include patterns for pull and push
- Selective uploads sync (UAG, Elementor, Hummingbird, Astra CSS — without pulling all uploads)

### Shipped in v0.1.1 — Security patch
- DB passwords migrated from plaintext `globalState` to encrypted `SecretStorage`
- TLS certificate validation enabled by default for cPanel HTTPS API (was opt-in)
- cPanel API `docroot` validated against safe path pattern before SSH exec (command injection fix)

### Shipped in v0.1.2–v0.1.8 — LocalDock Companion plugin + reliability
- **LocalDock Companion** — a per-site WordPress plugin (`wordpress-plugin/localdock-companion/`) that hooks into WP's native change events (`save_post`, `updated_option`, `activated_plugin`/`deactivated_plugin`, `switch_theme`, `add_attachment`, `wp_update_user`) and logs them to a `wp_localdock_changelog` table — a per-site approach chosen over server-level tracking to keep exposure contained to one site if a plugin is ever compromised (full rationale in `docs/localdock-companion-design-notes.md`)
- Read-only REST endpoint (`/wp-json/localdock/v1/changes`), per-site API key auth, daily WP-Cron retention pruning (default 30 days, filterable)
- **Provision Companion Plugin** command — SFTP upload, `wp-cli` activation when available, DB key readback, with a manual key-entry fallback when automatic activation/readback fails
- **Check for Changes (Companion Plugin)** command — polls the changelog endpoint since the last pull instead of a full file/DB diff; surfaces the specific objects that changed with a one-click pull
- Per-site Companion Plugin/API-key status (active/inactive/not installed, valid/invalid) surfaced in the sidebar tooltip so a silently-deactivated plugin doesn't go unnoticed
- Pull-state gating (`needed`/`busy`/`ready`) centralized in `siteStatus.ts` — Start Local and its inline sidebar button now always agree with the command's own precondition check
- SFTP concurrency raised (file transfers 5→20, directory walk 4→16 by default) after confirming requests pipeline over one SSH connection rather than opening one per file
- `mkdir` reliability fix — checks for an existing remote directory via `stat` instead of relying on ssh2's ambiguous EEXIST-equivalent status code
- Activity panel progress updates throttled (150ms) so percentages no longer jump erratically under high transfer concurrency

---

## v0.2 — WP-CLI + Developer Tools + Companion Hardening

- **WP-CLI terminal** — run `wp <args>` inside the Docker container from a VS Code terminal
- **PHP version switching** — pick `wordpress:php8.1-apache` / `php8.2` etc. and rebuild in place
- **Xdebug support** — optional toggle that layers a custom Docker image with Xdebug pre-wired to VS Code's PHP Debug extension
- **Companion plugin real-world testing** — validate against a live WordPress install; package a proper distribution zip (WP.org-style listing later)
- **Companion plugin file-level change detection** — on-demand server-side mtime/checksum sweep of `wp-content` for edits made directly via SFTP/FTP, which WP hooks can't see
- **Local git-history** — auto-commit into a local git repo after every pull, so LocalDock tracks what *you've* changed locally, complementing the Companion plugin's record of what changed on the origin site

---

## v0.3 — Import / Export / Blueprints

- **Site import from zip/backup** — unzip a cPanel full backup or a WP export into `localPath`, import DB, start local
- **Blueprints** — save any pulled site as a reusable starting template (zero-config WooCommerce, Astra starter, etc.)
- **One-click staging push** — push directly to a staging subdomain instead of production, with automatic URL rewriting

---

## v0.4 — Advanced Local Networking

- **Local SSL** — `mkcert`-generated cert + nginx reverse proxy so `https://sitename.localhost` works
- **Live share / tunnel** — expose the local site via Cloudflare Tunnel or ngrok, shareable URL in the activity bar

---

## Icebox (no timeline)

| Feature | Notes |
|---|---|
| Multi-server batch operations | Pull/push multiple sites across servers in one action |
| VSCode.dev / remote container support | Run the extension fully in-browser or inside a Dev Container |
| Plesk / DirectAdmin support | Extend beyond cPanel to other control panels |
| WooCommerce-aware URL rewrite | Detect and rewrite serialized cart/order metadata |
