# Changelog

All notable changes to **LocalDock for cPanel** are documented here.

## [0.1.2] — 2026-06-24

### Security
- **SSL certificate handling** — `Add Server` and `Edit Server` now try strict SSL first and only offer to bypass verification after an explicit cert error warning. The choice is stored per-server so future operations respect it.
- **Shell injection guard** — database user is now validated (alphanumeric + underscore only) before being interpolated into remote `mysqldump`/`mysql` commands, matching the existing guard on database name.
- **Path traversal fix** — remote docroot validation now explicitly rejects paths containing `..`.
- **Port validation** — SSH port input now enforces the valid range (1–65535).

### Code Quality
- **ESLint** — `eslint.config.mjs` added; `npm run lint` now works with ESLint 9 flat config and enforces `no-floating-promises`.
- **Unit tests** — `npm test` (Vitest) added with 20 tests covering `DatabaseSyncer.rewriteLineUrls` (PHP serialized URL rewriting) and `pathUtils` helpers.
- **`SiteRegistry.getServer(id)`** — new method eliminates repeated `.find()` calls across command files.
- **Progress adapter** — `makeProgressAdapter` extracted to `progressUtils`; pull and push commands use named constants instead of magic percentages.
- **Floating promises** — all unhandled promise warnings fixed; `SiteTreeProvider` discovery failures now log to the Output panel instead of silently disappearing.

## [0.1.0] — 2026-06-19

First installable release. The full round trip — pull → run locally in Docker → edit → push to
live — has been validated end-to-end against a real cPanel-hosted WordPress site.

### Features
- **Server management** — add, edit, remove, and test cPanel/WHM server connections.
- **Site discovery** — lists WordPress installs via the cPanel HTTPS API (no SSH needed to browse).
- **Pull** — download files over SFTP and the database via `mysqldump`, with a checksum manifest
  for diff-based pushes. Cancellable mid-transfer.
- **Local Docker environments** — spin up WordPress + MySQL + Mailpit + Adminer via Docker Compose,
  with automatic URL rewriting and `wp-config.php` patching.
- **Push** — upload only changed files and re-import the database to the live server. The database
  is exported from the running (or briefly started) Docker container.
- **Drive-eligibility check** (Windows) — flags site folders on drives Docker Desktop can't
  bind-mount (removable/exFAT/network) before a pull or local start, instead of failing deep inside
  Docker. Adds a **Set Local Sites Folder** command to relocate the sites directory.
- **Activity panel** with live progress, history, and cancellation.

### Known limitations
- Not yet published to the VS Code Marketplace — install via the `.vsix` from Releases.
- `wp-content/uploads` is not pulled by default (proxied from the live server at runtime).
