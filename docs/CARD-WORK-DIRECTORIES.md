# Card work directories

Each started executor, reviewer, reader, decision or batch card receives an absolute
`KANBAN_TMP` and a matching `TMPDIR` with a trailing slash. Put logs, copied files,
build output, screenshots, browser profiles and other disposable artifacts there.
Use the current card's display code; parallel cards have separate directories.

The default is `<project workspace>/.kanban-work/<card code>/`. The board first
uses `projects.<project>.workspacePath` in `kanban.config.json` (the older
`workspace` spelling also works). Without a configured directory it uses the
card's original repository directory, including the recorded source repository
of a temporary worktree. For example:

```json
{
  "projects": {
    "demo": {
      "defaultWorkspace": "dir",
      "workspacePath": "/path/to/<project-workspace>/demo"
    }
  }
}
```

The workspace must be a writable Git repository root. The board adds
`.kanban-work/` to Git's local `info/exclude`, preserving existing rules. Git
resolves that file through the common directory for linked worktrees. No tracked
ignore file is edited. New card directories and generation markers are created
with owner-only permissions.

If the project is not a Git repository, is missing, or its scratch/exclude path
cannot be written safely, the board uses
`<plugin-data-root>/work/<project>/<card code>/`. `<plugin-data-root>` is
`KANBAN_DATA_DIR`, otherwise `$PASEO_HOME/plugin-data/paseo-kanban`
(`~/.paseo/plugin-data/paseo-kanban` when `PASEO_HOME` is unset). Project names
are encoded as one directory segment. There is no system temporary-directory
fallback.
`KANBAN_TMP_ROOT` still explicitly selects `<override>/<card code>/`; an unusable
explicit override is reported and does not silently pick another root. If no
work directory can be prepared, dispatch refuses to start the agent instead of
inheriting the process default.

The actual prepared path is recorded in card events. Resuming an existing agent
rotates the generation at that path even after a config or override change.
Reader/decision permissions grant only that card directory alongside their
existing workspace/document scope, never its parent or another card's directory.
A supervisor's `--brief-file` may read inside the command's Git repository or an
allowed configured/fallback/explicit work root. Real paths are checked before
reading, so an escaping symlink remains refused. Arbitrary system temp files are
no longer accepted by default.

Done/archived card directories remain eligible for cleanup after 24 hours. The
existing ownership, agent-cwd, Git, activity/generation, retirement-journal and
per-round limits remain. Config changes do not strand recorded paths. Default
cleanup does not follow a replaced work-root symlink. Preserve lasting evidence
in the handoff or another authorized durable location before completion.

## Shared programs and what the card root keeps

The card root keeps only writable state that this card must not share: the host `HOME` and `PASEO_HOME`, the board database, and port configuration. Program trees, dependency installs and the npm cache stay outside the card, in shared directories. The default runtime directory is `$HOME/.kanban-cache/paseo-runtime/<sha256 of the official package-lock>`, prepared once by `scripts/shared-runtime.mjs` and then made read-only. A second install of the same lock waits on a lock file and reuses that directory. `KANBAN_SHARED_RUNTIME_ROOT` selects another parent directory. Tests point `PASEO_SERVER_DIR` at `node_modules/@getpaseo/server` inside it. A writable copy, when one is actually required, is an APFS clone (`cp -c`), not another `npm ci`.

The default npm cache is `$HOME/.kanban-cache/npm`. `KANBAN_SHARED_NPM_CACHE` overrides it. `scripts/isolated-environment.mjs` sets that cache and also sets `PASEO_VOICE_MODE_ENABLED=0` and `PASEO_DICTATION_ENABLED=0`. Host `config.json` written for tests sets `features.voiceMode.enabled` and `features.dictation.enabled` to false. An explicit voice check is a separate host that turns those switches on; it is not the default.

A successful test deletes its card-root workspace immediately. Put receipts, hashes and log summaries in the evidence directory before that deletion. The evidence directory is not inside the workspace that the test deletes. The board's later cleanup of a finished card directory is unchanged.

## Tests and switching an existing installation

The full test runner overrides inherited `KANBAN_TMP_ROOT` with a run-owned root;
each test worker preloads its own explicit card root and removes it afterwards.
CLI/fake-launcher children inherit it. The runner compares actual default-root
card-directory names before and after each phase and refuses newly added roots.
The negative audit fixture uses its own disposable project directory.

Upgrade only through the separately authorized installation procedure. Confirm
project workspace settings and writable local excludes, remove an old explicit
`KANBAN_TMP_ROOT` if the new default is wanted, and inspect the first new card's
environment and `card_tmp_prepared` event. Already running agents retain the
environment with which they were created; existing briefs and protocols are not
rewritten. Legacy system-temp directories without prepared-path events are not
automatically imported into the new cleanup roots. Inventory them separately
before any authorized cleanup. No production migration or release is performed
by this source change.
