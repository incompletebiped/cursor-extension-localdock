# Changelog

All notable changes to **LocalDock for cPanel** are documented here.

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
