# Architecture

> Skeleton. The sections below are filled in when the plugin code is imported.

## Two plugins, two repositories

- **Kanban for Paseo** (this repository, `jasonhnd/paseo-kanban`, plugin id `paseo-kanban`): the board, dispatch, review and acceptance.
- **Fleet Cockpit** (`jasonhnd/paseo-fleet`, plugin id `agent-fleet-cockpit`): roles, quota pacing, decisions inbox.

Each repository is one npm package whose root is the Paseo plugin folder, so `paseo plugin install github:<owner>/<repository>`, `npm:<package>` and a local checkout all install the same layout. The plugins never import each other. They exchange data through files described in [CONTRACT.md](CONTRACT.md), so each one works alone.

## Plugin layout

The repository root follows the Paseo plugin layout (`@getpaseo/plugin` 0.11):

| Path | Runs in | Rule |
|---|---|---|
| `index.client.tsx`, `client/` | the Paseo app | No Node built-ins. |
| `index.server.ts`, `server/` | a daemon child process | May use Node built-ins. |
| `shared/` | both | Bundled into the client too, so no `node:*` imports. |
| `shared/locales/` | both | `en.json` is the source language; other languages are translations. |
| `server/protocol/<language>/` | daemon | The texts agents receive (briefs, rules), one folder per language. |
| `bin/` | your shell | The `paseo-kanban` command-line tool, which reads the same data directory outside the daemon. |

No other code module sits in the root. `scripts/` holds the repository's own gates (plain Node scripts, never published, never compiled by Paseo).

Paseo compiles TypeScript itself and provides `@getpaseo/*`, React, React Native, zod and TanStack Query, so they are dev dependencies. The plugin has no runtime dependencies.

## Contract

`shared/contract/` and `server/contract/` are a vendored copy of paseo-fleet's `fleet-quota/v1` contract, recorded in `contract.manifest.json` (version and file hashes). `scripts/sync-contract.mjs` checks the copy and, given the source checkout, copies it over (see [CONTRACT.md](CONTRACT.md#source-and-copy)). Never edit the copy here.

## Shared gates

`scripts/`, `.githooks/` and `.github/workflows/` are byte-identical in both repositories. `scripts/compare-scripts.mjs` (part of `npm run verify` when `PASEO_FLEET_SIBLING` points at the other checkout) refuses any difference.
