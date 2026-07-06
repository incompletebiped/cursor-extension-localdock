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

### Shipped in v0.1.9–v0.1.13 — SSH hardening, site-discovery cleanup, Companion field-testing
- New SSH layer (`SshClient.ts` + `sshConnect.ts`) with a **Test Connection** command; SSH host keys pinned trust-on-first-use (SHA256 fingerprint, mismatch refuses the connection)
- Shared-docroot dedup in site discovery — domains pointed at another site's folder (e.g. an email-only domain) no longer show up as duplicate WordPress sites
- ESLint 9 flat config + a vitest unit test suite formalized (40 tests: `pathUtils`, `docrootDedup`, `DatabaseSyncer`, `semver`)
- **First real-world Companion Plugin validation**, against a live site (demo.baileykillian.com) — surfaced and fixed a genuine bug: WP-Cron's own housekeeping (`cron` option, `_transient_doing_cron`) was being logged as "drift" on every cron tick, drowning out real changes. Now filtered at the source (`is_ignored_option`, filterable via `localdock_companion_ignored_options`)
- **Companion Plugin version reporting + update detection** — the REST endpoint now reports its installed version; `checkCompanionDrift` compares it against the bundled version and prompts to re-provision when the site is running an outdated copy, surfaced in the sidebar tooltip too

---

## v0.2 — WP-CLI + Developer Tools + Companion Hardening

- **WP-CLI terminal** — run `wp <args>` inside the Docker container from a VS Code terminal
- **PHP version switching** — pick `wordpress:php8.1-apache` / `php8.2` etc. and rebuild in place
- **Companion plugin real-world testing** — ✅ started in v0.1.13 (demo.baileykillian.com, cron-noise bug found + fixed); still need a few more live sites to shake out edge cases before calling this done, plus packaging a proper distribution zip (WP.org-style listing later)
- **Companion plugin file-level change detection** — on-demand server-side mtime/checksum sweep of `wp-content` for edits made directly via SFTP/FTP, which WP hooks can't see

---

## v0.3 — Multi-Site Operations + WooCommerce Safety

- **Multi-server batch operations** — promoted from Icebox. Bulk actions across all sites in one go, especially bulk "Check for Changes" (Companion drift) so managing 20+ sites doesn't mean clicking through them one at a time
- **WooCommerce-aware URL rewrite** — promoted from Icebox. Detect and correctly rewrite serialized cart/order/product metadata during pull/push — 2 live WooCommerce sites have never been tested through the local-Docker flow yet, so this is a real, current risk, not a hypothetical one

---

## v0.4 — Import / Export

- **Site import from zip/backup** — unzip a cPanel full backup or a WP export into `localPath`, import DB, start local
- **One-click staging push** — push directly to a staging subdomain instead of production, with automatic URL rewriting

---

## v0.5 — Advanced Local Networking

- **Local SSL** — `mkcert`-generated cert + nginx reverse proxy so `https://sitename.localhost` works

---

## Icebox (no timeline)

| Feature | Notes |
|---|---|
| Xdebug support | Real idea, not confident it's needed yet — revisit if PHP debugging becomes a real bottleneck |
| Local git-history | Real idea (auto-commit local folder after each pull for a revertable timeline), not confident it's needed yet |

---

## Considered and cut

| Feature | Why cut |
|---|---|
| Blueprints | Tool's whole model is syncing *existing* production sites, not scaffolding new ones from templates |
| Plesk / DirectAdmin support | Contradicts the product's own identity — it's "LocalDock **for cPanel**," not a generic panel tool |
| Live share / tunnel | Not needed |
| VSCode.dev / remote container support | Doesn't fit the actual workflow (local Docker + local MySQL + SSH) — niche, no real use case here |
