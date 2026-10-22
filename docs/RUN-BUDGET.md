# Running-card resource limits

The scheduler watches every running or reviewing card, including batch work.
Each execution generation has its own elapsed wall clock, observed model rounds,
input/output tokens, cache-read tokens and consecutive waiting rounds. The card
drawer and `show` expose the latest snapshot. Unblock, rework and a new assigned
run start fresh counters. The scheduler checks once per ordinary tick (normally
one minute); this is a guard, not an exact spending cap.

Defaults are three hours, 150 model rounds, 30 million input plus output tokens,
and eight consecutive waiting rounds. Reaching 80% of any limit writes one warning
and notifies the registered project leader. Reaching a limit blocks the card as
`needs_human` and sends `paseo agent stop` for that agent. It preserves the session
and workspace. The stop is retried after failure while the card remains blocked;
the card records the failure and retains its execution capacity and directory lock
until interruption is confirmed. Unblock/rework is refused while a stop is in flight.

Add partial overrides to `kanban.config.json`:

```json
{
  "runBudget": {
    "maxDurationMs": 10800000,
    "maxTurns": 150,
    "maxTokens": 30000000,
    "maxConsecutiveWaits": 8
  },
  "projects": {
    "demo": {
      "defaultWorkspace": "dir",
      "runBudget": { "maxTurns": 200 }
    }
  }
}
```

Omitted keys inherit defaults, then global values, then project values. Limits
must be positive safe integers; invalid settings are refused. Global/project
changes also apply to an existing run on the next tick. The settings page preserves
these fields when saving other settings.

A project leader can grant a single resumed run a card override:

```sh
paseo-kanban unblock <card> --run-budget '{"maxTurns":300}' --reason 'Inspecting an unusually large migration'
```

The MCP `kanban_unblock` accepts the same `runBudget` object and `reason`. The
reason and granting identity are audited. The override belongs to the resumed
running generation; rework or another run restores the global/project limits.

Codex reads only the matching session transcript under `CODEX_HOME/sessions`
(or the default Codex sessions directory), capped at an 8 MiB tail. Distinct
`token_count` readings identify model calls within one outer agent turn. Repeated
quota readings do not increment calls. Input already includes cached input;
cache reads are reported separately and are not added twice. Other providers,
missing transcripts or incomplete usage use canonical assistant/tool cycles as a
lower bound. Tokens remain explicitly unavailable or partial, with one card note;
wall clock and available observations still enforce the limits. No credential
files are read. A retained tail can underestimate earlier activity on first
observation; subsequent observed rounds are persisted across scheduler reloads.

The board's marker-file wait uses `blocked_kind=background`, `background_wait`
and `background_resumed` events, and `unblocked` with `via=background_wait`.
These automatic resumes keep the original generation and counters. The monitor
excludes observations inside the wait interval, including late timeline pages.
Wall clock continues and is enforced when the card runs again. Other board-owned
wait implementations can supply `backgroundWaiting(task)` and persist
`background_wait_started` / `background_wait_finished` with `agentId` (and
optionally the budget generation). Leader unblock still resets the budget.
