# LocalDock Companion Plugin — Design Notes

## Problem

LocalDock (VS Code/Cursor extension, Docker-based local WP dev, SSH push/pull to cPanel/WHM server) currently has no way to know if the **live site** changed since the last pull. Right now the only way to detect drift is a full file hash walk and/or DB comparison over the existing connection — this is slow and is the main performance bottleneck.

Goal: get git-like awareness of "origin has moved since your last pull" — without doing a brute-force diff every time.

## Decision: per-site WordPress plugin (not server-level tracking)

Considered and rejected a server-level approach (MySQL triggers across all databases + `inotifywait` on `wp-content` + a central changelog DB on the dedicated server). Rejected for **security/blast-radius reasons**: a compromised central daemon or changelog DB would expose activity across every client site on the server. A per-site plugin keeps each site's exposure contained to that site only — consistent with LocalDock's existing trust model (e.g. `wp-config.php` never auto-pushes, DB pushes always require explicit confirmation).

Server context: dedicated Namecheap server, WHM/cPanel, root access confirmed available. Server-level approach was technically viable but not chosen for security reasons above.

## How it works

1. **Plugin hooks into WP's native change events** and logs each one to a custom table instead of LocalDock having to infer changes from outside:
   - `save_post`, `deleted_post`
   - `updated_option`
   - `activated_plugin` / `deactivated_plugin`
   - `switch_theme`
   - `add_attachment`
   - `wp_update_user`
   - (extend as needed)

2. **Custom table**: `wp_localdock_changelog`
   - `id`
   - `object_type` (post, option, plugin, theme, attachment, user, etc.)
   - `object_id`
   - `action` (created, updated, deleted, activated, deactivated, etc.)
   - `timestamp`

3. **REST endpoint** (read-only): `/wp-json/localdock/v1/changes?since=<timestamp>`
   - Returns changelog rows since the given timestamp as small JSON payload
   - No write-back capability, ever
   - Auth: per-site secret/API key generated on plugin activation, stored in `wp_options`, checked on every request. LocalDock stores the key using the same VS Code `SecretStorage` pattern already used for SSH credentials. Do not rely solely on WP cookie auth.

4. **LocalDock stores a "last synced" marker** (timestamp or manifest hash) after every pull — this is the local equivalent of git's "last known commit from origin."

5. **Before push, or on demand**: LocalDock hits the REST endpoint instead of re-diffing everything.
   - Empty response → local copy is current
   - Non-empty response → surface what changed (which post, which option, which plugin) instead of a vague "things are different" warning

6. **File-level changes** (e.g. theme files edited directly via SFTP, not through WP itself) aren't caught by hooks. Plugin can still do an on-demand server-side mtime/checksum sweep of `wp-content` — runs faster than doing it from the extension side since it executes as PHP on the server rather than pulling files over the existing connection.

## Extension-side integration

- LocalDock should detect and track whether the companion plugin is **installed and active** on a given site (not just installed) — this is the main failure mode of a plugin-based approach, since a deactivated plugin silently stops reporting. Surface this status clearly per site.
- Store per-site API key via `SecretStorage`, same as SSH credentials.
- New "provision this site" flow: install/activate plugin + generate/store key, alongside existing SSH setup.

## Security notes for the plugin

- Read-only REST endpoint — no write-back, even with a valid key
- Namespace clearly for auditability: `localdock/v1/...` route, `wp_localdock_changelog` table — obvious to a client if they audit their plugin list
- Per-site scoped API key, not shared across sites
- Consistent with LocalDock's existing guardrails: no automatic `wp-config.php` push, DB pushes require confirmation

## Local git-history idea (separate, optional)

Not part of this drift-detection problem, but worth layering in separately: auto-commit into a local git repo after every pull, giving LocalDock proper local edit history. The plugin's changelog answers "has origin moved"; this would answer "what have I changed locally since."

## Open items / next steps

- [ ] Plugin file structure (main plugin file, hook-to-changelog logic, REST endpoint + key auth)
- [ ] Changelog table schema finalization (indexes, retention/pruning strategy)
- [ ] REST response shape (JSON schema)
- [ ] Extension-side: plugin active/inactive detection + UI indicator
- [ ] Extension-side: "last synced" marker storage and comparison logic
- [ ] Provisioning flow: install plugin + generate key as part of adding a new site to LocalDock