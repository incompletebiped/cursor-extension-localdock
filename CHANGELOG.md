# Changelog

All notable changes to **LocalDock for cPanel** are documented here.

## [0.1.13] — 2026-07-03

### Fixes
- **Sites pulled under an old Local Sites Folder kept showing as pulled** — changing
  `localdockCpanel.localSitesDirectory` (e.g. switching to a different drive) only affects *future*
  pulls; it doesn't move anything already on disk. A site pulled under a previous setting kept its
  original `localPath`, so `reconcileLocalState` found its manifest right where it left it and kept
  reporting it as pulled — correct on its own terms, but not what "only sites on the selected drive"
  means to the user. Sites whose stored `localPath` falls outside the *current* Local Sites Folder
  are now treated as not pulled regardless of whether the old folder is still intact elsewhere.

## [0.1.12] — 2026-07-03

### Fixes
- **Stale "pulled" state survived deleting a folder's contents** — 0.1.10's reconciliation check
  (`reconcileLocalState`) only verified the pulled folder itself still existed. Deleting everything
  *inside* the folder (rather than the folder itself) left an empty directory behind, which still
  passed that check, so the site kept its checkmark and kept showing under Local Environments.
  The check now looks for `.localdock/manifest.json` instead of the bare folder — the marker file
  written on a completed pull, which is gone along with everything else once the contents are
  deleted. Missing manifest now correctly resets the site to Not Pulled on Refresh Sites.

## [0.1.11] — 2026-07-03

### Features
- **Trust a removable drive for Docker bind-mounts** — Docker Desktop normally only bind-mounts
  fixed NTFS/ReFS drives, so a removable-but-NTFS drive (e.g. an SD card or USB drive that's kept
  permanently attached) previously triggered a hard block on every pull/start, with no way around
  it short of moving everything to `C:`. The eligibility warning now offers a "Trust This Drive"
  button (shown when picking a Local Sites Folder or when a pull is blocked) that records the drive
  letter in the new `localdockCpanel.trustedRemovableDrives` setting. Once trusted, that drive is
  treated as eligible everywhere without asking again. Still hard-blocks exFAT/FAT and network
  drives, which genuinely can't be bind-mounted regardless of trust.

## [0.1.10] — 2026-07-03

### Fixes
- **Stale "pulled" state after manual folder deletion** — deleting a pulled site's local folder
  outside the extension left it showing a green checkmark in WordPress Sites and a phantom entry
  under Local Environments, since nothing re-checked the folder until the next window reload.
  `Refresh Sites` now reconciles every site's local state the same way startup already did: verifies
  the pulled folder still exists on disk and, for a site marked "running", that its Docker containers
  are actually still up. Either missing resets the site to Not Pulled (and clears it from Local
  Environments) instead of leaving it stuck. Extracted the previously activation-only check into
  `reconcileLocalState()` so both code paths share the same logic.

## [0.1.9] — 2026-07-03

### Features
- **Self-update check (dev workflow)** — new `localdockCpanel.devRepoPath` setting points the extension
  at its own source repo. On startup (and via the new `LocalDock cPanel: Check for Updates (Dev)`
  command) it compares the repo's `package.json` version against the installed one and, if the repo
  is ahead, offers to rebuild, repackage, reinstall, and reload the window — no more manual
  `vsce package` / `cursor --install-extension` after every change. Opt-in and no-op unless
  `devRepoPath` is configured.

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
