# Quota routing for new agents

New scheduler, manual, linked/inline review, replacement and cloud starts use
`routeProfile` with the card context. The router intersects the live matrix with
`qualificationForNewAgent`, chooses each model's first qualified depth, removes
candidates whose estimated cost crosses a reserve, then calls `rankPools` on the
surviving pools. A primary candidate that fails cost admission cannot suppress
Claude fallback. Inside a pool, the lightest qualified model/depth wins.

The matrix still controls membership, pauses and the high-risk review list.
Actual-model review isolation, fast/Cursor exclusions, family rules, capacity
and the run-budget brake remain enforced. Explicit profiles use the same gate
and stay pinned; they cannot bypass qualification or quota. A resumed agent
keeps its established session depth. Fresh replacement agents advance one
qualified step per return. A stopped review followed by its leader continuation
counts as one return.

## Cost and evidence

`server/run-cost.ts:costEstimate` reads `fleet/run-costs.json`; the additive
`pool` query filter prevents mixing percentages from different allowances.
Queries include actual model, selected effort, card type, role and stored tier.
Types match the cost recorder: `code`, `review`, `read`, `ops`, `batch`, and the
remaining role names. No new token collection or historical backfill is added.

Defaults are three quota samples, a 1.5 multiplier on the observed mean, and a
five percentage point fallback. With fewer samples the estimate is the greater
of that fallback and the buffered observed mean. With enough samples the
buffered mean has a 0.25 point floor. Missing tokens do not become invented
quota samples. Every choice names the pool, remaining/reserved/surplus points,
depth reason, estimated percentage, sample count and whether the default was
used. The `started.reason` (or cloud start reason) appears on the card and drawer.

Parents are quota evidence even without eligible profiles. A child also checks
an independently estimated parent cost, using a conservative default when the
parent has no matching measurements. Fleet publishes `adapter`, `providers`,
`parent` and `reservePct` with its forecast, and the immutable contract preserves
them. Ordinary Codex retains 20 points; ordinary main Claude retains 25; children
retain zero unless the active burn phase supplies another line. Claude's double
week and reviewer exception retain their effective reserve. A new immutable
start waits for refreshed parent/reserve metadata after an upgrade. Stale quota
is bounded as unknown; it never becomes a full pool.

Forecast-limited pools take only L3/L4. Unknown pools retain the existing shared
`unknownQuota` limit (default one concurrent L1/L2 start across all roles and
profiles); Fleet sends the existing deduplicated leader notices. After awaited
placement/catalog work, the create boundary rechecks the chosen candidate and
current pool-wide occupancy. The revision/digest guard still rejects changed
immutable policy.

## Configuration and rollback

Global `kanban.config.json` settings, with their defaults:

```json
{
  "quotaRouting": {
    "enabled": true,
    "minSamples": 3,
    "defaultCostPct": 5,
    "safetyFactor": 1.5,
    "reserves": {},
    "dispatchPriority": null
  }
}
```

Omitting the object enables the new router. `enabled: false` restores the
previous matrix/roster ordering and depth resolution for fresh starts. It does
not change running sessions or erase observations. `reserves` overrides specific
pool ids, including the personal Codex allowance; change these only with the
owner's approval. `minSamples` is 1..1000, `defaultCostPct` is 0.25..100 and
`safetyFactor` is 1..10. Invalid configuration is refused.

The existing `plans.json.dispatchPriority` and published matrix priority are
ignored by the new router. Only a newly configured
`quotaRouting.dispatchPriority: { "order": ["demo-pool"], "until": "2030-06-02T00:00:00Z" }`
pins the surviving safe pools. Expiry restores automatic ranking. Keep this
field null during rollout; copying the old fixed order would defeat the change.
The published Fleet-wide order remains a compatibility view for old clients.

## Authorized installation and observation

This change prepares the next candidate after the current release line; it
performs no installation, publication or production configuration edit.
During an authorized update, pause dispatch and old writers, install matching
Fleet/daemon/CLI code, and preserve the existing run-cost data and configuration.
Keep the new router enabled (or omit its object), keep its new priority null,
and choose any approved reserve/estimate overrides. Refresh pools and immutable
policy before resuming; confirm parent/reserve/forecast fields, exact model ids,
provider thinking options and role/high-risk lists. Dedicated operations defaults
remain Sonnet low; Gemini or other installation-specific model ids require
explicit qualification cells as well as the existing authorization gates.

Observe three days of real work. Record pool usage at reset (target 80–97%),
resets/exhaustion and unknown episodes, runs by role/model/effort/pool, estimate
versus recorded quota delta, quota sample counts/default frequency, reserve
holds, pool occupancy, return escalation, rejected same-model reviews and brake
events. No pool should exhaust before reset. These are production acceptance
criteria for the leader; local regressions do not establish them. Quota readings
can lag concurrent consumption and observed averages are estimates, so tune
approved margins from the recorded data. If dispatch regresses, set
`quotaRouting.enabled` false, refresh policy, and inspect the retained reasons
and observations before re-enabling.
