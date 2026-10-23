# Quota management

[Simplified Chinese](zh-CN/QUOTA-MANAGEMENT.md)

## X Ultra: one seat, one weekly pool

The X Subscription Ultra has a $200/month list price. Eligible first-party usage
across Grok CLI/App, the subscription Bot, and Grok/Cursor-owned models in Cursor
spends **one weekly seat pool**, identified here as `x-ultra`. Third-party models
in Cursor (including Claude and GPT) are paid Additional Usage from their first
use; they are outside this included pool. See the official
[usage limits](https://docs.x.ai/x-subscription/usage-limits) and
[pricing](https://docs.x.ai/x-subscription/pricing) (checked October 2026).
Billing dates and weekly reset dates are separate.

The runtime reads `supergrok` and `cursor` as legacy aliases of `x-ultra`, without
rewriting the source files. The merged plan uses `grok-cli`, both provider labels,
and one subscription price. A new `x-ultra` plan takes precedence over old rows;
otherwise the old Grok plan supplies the dispatch settings. Old Cursor monthly
`cycleDay`, bundled price, `manual` Auto percentage and Included/Auto/API windows
are discarded. For the known legacy ids this is an explicit entitlement
migration; unrelated accounts should use distinct, custom pool ids.

The Grok CLI/provider observation and Cursor's explicitly labelled **Grok** row
are alternative evidence for the same week. Cursor's Grok row must supply its
own full reset timestamp; the old top-level monthly reset is never substituted.
Expired Auto billing metadata cannot invalidate an independently fresh Grok row.
The newest usable source clock wins, without refreshing its age on publication.
Readings must be within two sampling intervals (two hours), have a future reset,
and have no future source clock. Current resets differing by more than a minute,
a same-clock percentage disagreement, or a decrease within the same reset period
make the result unknown. An exhausted older reading in that same period cannot
be replaced with a lower percentage. Existing authentication and exhaustion
stops still apply. Missing or ambiguous evidence never becomes zero usage.

The panel renders one X Ultra plan/company and one weekly pool. Forecasts,
unknown-quota occupancy, daily consumption and run-cost exports use `x-ultra`.
Old Grok history can continue a compatible weekly series; historical Cursor Auto
readings cannot establish weekly usage. Legacy profile pools and priority ids
normalize at read boundaries. Existing records are not rewritten in place.
In `disabledPools`, only `supergrok` and `x-ultra` refer to a shared quota stop.
The legacy `cursor` stop controls the Cursor transport alone; it must not close
Grok CLI dispatch. Legacy channel concurrency counts add together; conflicting explicit concurrency caps use the
smaller value.

### Bot and personal reserves

`plans.json` has two independently configurable percentage-point reserves:

```json
{
  "id": "x-ultra",
  "name": "X Ultra",
  "adapter": "grok-cli",
  "usageProvider": "grok",
  "providers": ["grok", "cursor"],
  "priceUsdMonthly": 200,
  "dispatch": true,
  "cliRead": true,
  "screenRead": false,
  "xUltraReserve": { "botPct": null, "userPct": null }
}
```

Both values await the user's decision. Each must be between 0 and 100, with a
combined total no greater than 100. Explicit zero is a configured decision;
missing, null or invalid values are **not** zero. Until both are set, dispatch
uses unknown-quota bounds: at most **one concurrent L1/L2 job across the seat**.
A narrower configured unknown policy still wins; a wider one cannot open L3/L4
or additional concurrency. Real usage stays visible, and existing hard stops or
`dispatch: false` remain closed. No numerical reserve is invented.

Once both values are configured, their sum is subtracted from the remaining
allowance for ranking, and dispatch stops at `100 - sum`, or any stricter plan
stop. These fields reserve headroom for the Bot and personal usage; those
surfaces still draw from the same live reading. Neither a row reserve override,
a manual priority, nor a difficult card can reduce the configured reserve.
The normal exhausted-pool stop also remains in force.

### Dispatch and configuration handover

Cursor transport remains reserved for the Bot. Paseo does not gain permission to
start Cursor agents by sharing the Grok CLI pool. Cursor third-party or unknown
model ids receive an explicit paid-usage refusal before selection/launch. This
invariant covers roster selection, matrix and overrides, explicit `--profile`,
review reservation, local preselection, returned-run resume and cloud launch.
Provider/channel evidence is checked independently of editable family/pool
labels. First-party recognition covers Grok, versioned Composer and Cursor-owned
model ids; recognizing them does not open the reserved Cursor channel.

After installing the code, the daily leader should replace the old two rows in
production `plans.json` with the single row above, retain intentional Grok
settings such as stricter `stopPct`/role limits, and remove obsolete monthly and
bundled-plan fields. Set the two reserves only after the user decides. Move
profile pools, explicit pool caps and new priority pins to `x-ultra` for clarity;
read aliases remain compatible. A deliberate shared-quota stop under `supergrok`
may be renamed to `x-ultra`. After installing the code, remove the legacy
`cursor` entry from `kanban.config.json` `disabledPools`; **do not rename it to
`x-ultra`**. Existing configurations that retain `cursor` keep Grok CLI available,
and the code-level Cursor channel refusal remains active after removing that
obsolete entry. Preserve unrelated stop entries. Do not carry the old fixed dispatch
priority into automatic ranking as a new user pin.

In `afc.config.json`, keep `adapters["cursor-api"]: true` when the existing
authorized official reader should contribute the Grok row. Keep the plan's
`screenRead: false` to avoid enabling an interactive screen during migration.
If that adapter is off, only Grok's usable evidence contributes. Preserve other
intentional settings; no second pool, manual Auto allowance or extra paid-model
adapter is needed. Installing code alone never edits these production files.

## Recent usage forecasts

Each published pool snapshot includes `burnRatePctPerHour`, `projectedPct`,
`runsOutAt` and `forecastConfidence` (`high`, `low` or `none`). `projectedPct`
is the projected **used** percentage at reset and may exceed 100. `runsOutAt`
is populated only when the estimated exhaustion time precedes reset. The quota
page shows either this date or the estimated percentage used at reset.

The local `fleet/quota-forecast-history.json` series stores at most one sample
per five minutes, bounded to seven days and 2016 rows. Source timestamps are
preserved; cached readings do not become new evidence. This file is separate
from the daily `quota-history.json` used for per-run accounting.

The forecast uses the endpoint slope over up to six recent hours in the current
reset period. A changed reset, decreasing usage, conflicting source timestamp,
missing reading or gap exceeding two hours breaks the series. At least two
readings spanning fifteen minutes are required, and the latest must be within
thirty minutes. Missing usage, source time or cycle bounds produces `none` with
null forecast values. Legacy sources without a timestamp field use the sample
clock. Three or more readings spanning an hour with interval rates within 50%
(or 0.5 percentage points/hour) of the endpoint slope give `high`; otherwise
sufficient evidence gives `low`. A sudden jump therefore lowers confidence.
These are linear estimates, and collecting fresh evidence after reset takes time.

## Pool ranking (routing step 2)

`shared/fleet/pool-ranking.ts` exports
`rankPools({ pools, now, tier, role, dispatchPriority? })`. `now` is epoch
milliseconds. Results are `{ pool, score, reason, allowedTiers }` in dispatch
order, restricted to the requested tier and role. The function is pure and does
not read production files. Reasons use the active Fleet language and can be
stored on the dispatched card.

The [combined router](QUOTA-ROUTING.md) connects this step to model eligibility and dispatch. Pass only eligible
pool candidates, retaining their parent quota rows as evidence. Mark parents
without an eligible model as `eligible: false`; their quota still gates children,
but they cannot be selected or suppress Claude fallback. Use
`withPoolRankingMetadata(snapshot.pools, rawPlans, poolWideOccupancy)` to attach
catalog adapters, parent ids, reserves and occupancy. Model eligibility and
ordinary concurrency limits still belong to admission; this module does not
select models or effort. The existing published global priority remains a
compatibility view; new starts use per-card ranking.

Rules, in precedence order:

1. Cursor transport candidates are excluded, including renamed plans identified
   by adapter/provider. The shared `x-ultra` pool remains eligible through Grok
   CLI; its `cursor` read alias is not a second candidate pool.
   Closed pools and role limits remain closed. Sub pools cannot bypass the
   parent's stop, reserve, role, unknown capacity or forecast restriction.
2. Missing, expired or explicitly unknown quota follows G1d's `unknownQuota`
   policy: by default one concurrent job across all profiles/roles, L1/L2 only.
   Supply that shared occupancy as `activeRuns` (or the helper's third argument).
   Unknown gets score zero, never a fabricated 100% allowance. G1d retains its
   separate deduplicated unknown warning.
3. Remaining points are `100 - usedPct`. Surplus subtracts `reservePct` from
   remaining points. A valid per-pool row reserve has highest precedence;
   `withPoolRankingMetadata` preserves it even when a plan has a different
   reserve. A valid `plans.json` plan reserve applies only to its main pool,
   when that row has no valid reserve. Missing plan values never erase a row
   reserve, and plan values never flow into sub pools. Values range from zero
   through 100. X Ultra uses the combined Bot/personal reserve above; missing
   values impose its bounded unknown policy. Defaults for other pools are 20 for the main Codex pool, 25 only for an ordinary
   Claude main week without a parent, and zero for sub pools and other pools.
   Callers must supply each pool's current reserve as `100 - currentStopPct`
   for special modes: for example 10 for a 90% double-week stop, zero for a
   100% front burn-week stop, or 2 for a 98% reviewer exception. Ranking does
   not infer coupon modes or dated role exceptions. Claude's model sub pool
   keeps its own normal 97% hard stop from `dispatchable`, as well as its
   parent's reserve and stop; zero reserve does not reopen a hard stop.
   Nonpositive surplus cannot dispatch, including L3/L4.
4. Known, safe pools score `1 + surplus / max(daysUntilReset, 0.5)`. Larger
   surplus and a nearer reset increase urgency. Missing reset gives no urgency
   bonus. With G1c confidence `high` or `low`, `projectedPct > 100` or
   `runsOutAt < resetsAt` limits a pool to L3/L4. Its score is urgency / 1000,
   below every known safe pool and above unknown pools. Forecasts with `none`
   do not apply this brake. A passed cycle is unknown until fresh evidence;
   a fresh reset and cleared forecast restore the normal tier range.
5. Claude is fallback only: it appears only when no eligible non-Claude pool
   survives these guards for this tier/role. Filter model eligibility before
   ranking so an unusable non-Claude model cannot hide a viable fallback.
6. At G2c rollout, pass `dispatchPriority: null` for the old fixed Codex →
   Grok → Claude order, including the carryover ending October 27. It is the
   order this routing change replaces; its unexpired `until` is not evidence
   of a new user pin. Do not automatically forward an active legacy
   `plans.json.dispatchPriority` into `rankPools`. This lets the near-reset
   Grok pool lead the forecast-limited Codex pool in the design's scenario.
   Only a pin explicitly set by the user after the new routing takes effect
   should be passed as `dispatchPriority`; the existing parser remains the
   compatibility reader for that format. Such a pin reorders surviving
   candidates only, never bypasses the preceding guards or Claude fallback.
   Unlisted candidates follow by score. Null, invalid or expired pins use
   automatic ranking. Equal scores use pool id order for deterministic
   results. Manual reasons include the expiry.

The AFC heartbeat warns registered project leaders about forecast exhaustion.
`fleet/pool-exhaustion-notices.json` stores successful recipients per pool and
reset; concurrent refreshes serialize, failed recipients retry, and forecast
oscillation or a missing read does not repeat the same cycle's warning. Panel
reads send no messages. Existing source clocks and G1c confidence rules apply;
no second forecast or usage collector is introduced.

The snapshot recalculates `wastePct`/`wasteRisk` after attaching the recent
forecast. These remain display fields; ranking uses reserve-adjusted surplus
and the forecast brake. Claude's spending sentence explicitly refers to up to
six hours of readings in the current cycle, matching G1c's sampling method.
When that forecast is missing, the spending summary preserves insufficient
evidence instead of substituting a whole-cycle average.
