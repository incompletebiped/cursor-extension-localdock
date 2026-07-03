# LocalDock Companion — WordPress Plugin

> **Not part of the VS Code/Cursor extension build.** This folder is a separate WordPress plugin, installed on the *live cPanel site*, not on the developer's machine. It is excluded from the extension's `.vsix` package (see `.vscodeignore` at the repo root) and has its own release/distribution path (zip for manual install, or a WP.org-style plugin listing later).

## What this is

The companion plugin lives on each WordPress site that LocalDock manages. It hooks into WordPress's native change events (`save_post`, `updated_option`, `activated_plugin`, etc.) and logs them to a small changelog table, exposed read-only via a REST endpoint (`/wp-json/localdock/v1/changes`). LocalDock (the extension) polls that endpoint instead of doing a brute-force file/DB diff to detect drift since the last pull.

Full design rationale: see `../docs/localdock-companion-design-notes.md`.

## Relationship to the extension

| | LocalDock extension | LocalDock Companion plugin |
|---|---|---|
| Runs on | Developer's machine (VS Code/Cursor) | The live cPanel WordPress site |
| Distributed as | `.vsix` (this repo's build output) | Plugin zip, installed on the site |
| Source location | `src/` (repo root) | `wordpress-plugin/localdock-companion/` (this folder) |
| Built by | `esbuild.js` → `dist/extension.js` | N/A — plain PHP, no build step |

The extension's "provision this site" flow (planned) will install/activate this plugin on the target site and store its generated API key via `SecretStorage`, the same way SSH credentials are handled today.

## Folder layout

```
wordpress-plugin/
  localdock-companion/         # the actual WP plugin — this is what gets zipped and installed
    localdock-companion.php    # plugin bootstrap (header, activation/deactivation hooks)
    uninstall.php               # runs on plugin delete (not deactivate) — drops table + options
    includes/
      class-changelog.php      # save_post/updated_option/etc. hooks -> wp_localdock_changelog table, + daily retention pruning
      class-rest-api.php       # read-only /wp-json/localdock/v1/changes endpoint + key auth
      class-admin.php          # Settings > LocalDock Companion — view/regenerate API key
```

## Status

Core plugin scaffolding is done: changelog hooks, REST endpoint, uninstall cleanup, retention pruning (daily WP-Cron, default 30 days, filterable via `localdock_companion_retention_days`), and an admin settings page for the API key. Untested against a real WordPress install so far — see the "Open items" checklist in the design notes doc for what's left, plus the extension-side integration work.
