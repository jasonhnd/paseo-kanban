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

A card directory is deleted on the cleanup round that finds the card done or
archived. The board does not wait. Rework, blocked and other unfinished cards
keep their directories. Cleanup still refuses another user's directory, a card
root that is itself a Git repository, a directory whose generation changed, a
directory an agent opened by that card still has, and a directory any process
is using as its working directory. It does not walk the tree or stop at a file
count. A removal that fails is a doctor red and is retried with backoff.
Config changes do not strand recorded paths. Default cleanup does not follow a
replaced work-root symlink, and it never deletes an evidence directory.
Preserve lasting evidence in the handoff or another authorized durable location
before completion.

## Capacity

Each scheduler round measures the allocated size of the card-work roots with `du -sk` (allocated blocks, not apparent size; a symlink at the measured path is not followed). A successful reading is cached for about 10 minutes, or until that directory's mtime changes. Files that grow inside a card directory without changing that directory's mtime can lag until the cache expires. Free space is read with `statfs` on every round and is not cached.

The measured roots are each project's `.kanban-work` directory and the plugin-data fallback root. When `KANBAN_TMP_ROOT` is set, only that root is measured. The total is the `du` of each root, not a second sum of its children. If roots sit on more than one disk, the free-space figure is the smallest, and any disk under the free-space limit pauses a new card's first work start.

Defaults: pause when card-work usage is greater than 10 GiB, or when free space is less than 50 GiB. Either limit is enough. Configure both in `kanban.config.json`:

```json
"capacity": { "maxWorkGiB": 10, "minFreeGiB": 50 }
```

A missing `capacity` key uses those defaults and is not written back by a save. `0` and any other non-positive number falls back to the same defaults. Exactly 10 GiB of card work, or exactly 50 GiB free, does not pause.

While the brake is on, `start` and automatic start return the reason for a brand-new executor, batch, reader, or decision card that has never run, and that card stays queued. Review cards, rework (a resume of the original agent, a new executor for the same card, and a reopened ready card), and `in_review` / `reviewing` progress still start. Cards already running or reviewing are not interrupted. The next round that is back under both limits clears the pause by itself. Cleanup after acceptance can drop usage under the limit; the following round then lets the queued cards start.

`kanban doctor` reports red `board:capacity` with the current amounts, both thresholds, and the five largest card directories with each card's status. The Kanban leader gets one reminder for that episode, not a repeat on every round. A failed `du` or `statfs` does not start a pause on its own: the last good reading is kept and judged against the current limits, and doctor adds an info line. With no earlier reading, new starts continue.

Completing or accepting a card stores `tmp_work_bytes` once. `show`, list and the board show that size when it is present. Later growth does not change the stored number. A missing directory or a failed `du` leaves the field empty and does not block completion.

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
