# Model and depth qualification

`shared/fleet/executor-effort.ts` owns the quality floor used by quota routing. The
existing dispatch matrix owns live profile names, availability and order; it is
not a second quality table. Its compatibility max clamp now reads this same
quality table. Pool selection, quota protection, live catalog checks, standard
speed and different-actual-model review checks remain separate admission steps.

## API

```ts
qualifiedCandidates({ role, tier, cardType, reworkCount, explicitEffort }, {
  global: config.qualification,
  project: config.projects?.[project]?.qualification,
}); // Array<{ provider, model, effort }>
```

The result contains every eligible model/depth pair from the current starting
point through its ceiling, ordered by increasing depth. Ties retain table order.
Use the first matching depth for a selected model. A quota ranking must not pick a
later, more expensive depth for that same model merely because it is available.
This function does not choose pools, resolve profiles or verify provider catalogs.
Unknown roles/tiers, invalid rework counts and invalid explicit efforts return no
candidates. Returned objects are independent of the frozen defaults.

A new run starts at each model's smallest qualified depth. Every return advances
one available depth for that model, up to its ceiling. Repeated rows for the same
provider/model are combined before advancing, so they cannot reset the start.
L3/L4 have a hard minimum of high, including explicit card requests. Operational
executor/batch cards use only Luna or Grok at low. Dedicated `ops_*` roles use
their own configured models at low; they do not have the light-executor model
restriction. Both kinds stay at low even with rework or an explicit max request.
Card types use the existing `operationalExecution` classification and tag precedence.

A non-max explicit effort sets the minimum starting depth for each model. Select
its first qualified depth at or above that request, then advance once per rework
and cap at its highest qualified depth. For example, Sol with explicit high starts
at high and uses xhigh after one return; explicit medium on an L4 card starts at
high. A model with no qualified depth at or above the request is excluded.
`max` is available only when the card requests it and the model row
has `allowExplicitMax: true`; it is never a normal depth or a rework ceiling.
`ultra` is unsupported. Cursor and retired `build-fast` model ids never appear
in this API's output. Dispatch must also retain its standard-speed settings check.

## Defaults

The complete machine-readable table is [the example](../examples/qualification.example.json).
Model identities are exact: Sol is `codex/gpt-6.1-sol`, Luna is
`codex/gpt-6-luna`, Grok is `grok/grok-4.7`; the older Sol review option
is `codex/gpt-6-sol`. Claude defaults use complete model ids:
`claude/claude-sonnet-5-5`, `claude/claude-opus-5-5` and
`claude/claude-fable-5-1`. Reader Sonnet uses the configured long-context identity
`claude/claude-sonnet-5-5[1m]`. Fable participates in L4 high-risk review and decision
work at high. Replace cells if the installed catalog uses different ids.
Claude's fallback status is enforced by pool selection, not by this depth sort.

| Role | L1 | L2 | L3 | L4 |
| --- | --- | --- | --- | --- |
| executor | Luna/Grok/Sonnet low–high; Sol medium–xhigh | Sol medium–xhigh; Grok/Sonnet medium–high | Sol/Opus high–xhigh; Sonnet high | Sol high–xhigh |
| reviewer | Luna high; Grok low–high; both Sol models high–xhigh; Sonnet medium–high | Luna high; Grok/Sonnet medium–high; both Sol models high–xhigh | both Sol models, Grok, Opus high–xhigh; Sonnet high | both Sol models, Grok, Opus high–xhigh; Fable high |
| reader | Luna/Grok/long-context Sonnet low–high; Sol medium–xhigh | same as L1 | Sol/Grok/Opus high–xhigh; long-context Sonnet high | same as L3 |
| decision | Sol/Opus medium–xhigh; Grok medium–high; Fable high | same as L1 | Sol/Grok/Opus high–xhigh; Fable high | same as L3 |
| batch | Luna/Grok/Sonnet low–high; Sol medium–xhigh | Luna/Grok medium–high; Sol medium–xhigh | Sol/Grok/Opus high–xhigh | Sol/Grok/Opus high–xhigh |
| operational executor/batch | Luna/Grok low | Luna/Grok low | Luna/Grok low | Luna/Grok low |
| ops_vercel/cloudflare/github/notion | Sonnet low | Sonnet low | Sonnet low | Sonnet low |

## Configuration

`kanban.config.json` accepts `qualification` globally and inside each project.
Built-ins supply omitted cells; a global cell replaces its built-in list; a
project cell replaces the global list. An explicit empty array closes that cell.
Invalid shapes fail configuration parsing rather than silently opening fallback
candidates. Only low/medium/high/xhigh belong in `efforts`.

```json
{
  "qualification": {
    "executor": {
      "L4": [{ "provider": "codex", "model": "gpt-6.1-sol", "efforts": ["high", "xhigh"], "allowExplicitMax": true }]
    }
  },
  "projects": {
    "demo": { "qualification": { "executor": { "L4": [] } } }
  }
}
```

`ops` supplies the operational executor/batch table and generic fallback for
`ops_vercel`, `ops_cloudflare`, `ops_github`, `ops_notion`. Resolve a dedicated role
first across project, global and built-in cells; only if all are absent, resolve
`ops` across project, global and built-in cells. Thus a project generic `ops` cell
cannot hide a global or built-in dedicated role cell, and an empty dedicated
cell remains closed. Shipped dedicated cells use Sonnet low; configure the
specific role to change them. The Cursor/retired-id exclusion, L3/L4 minimum,
light operational executor/batch restriction and low dedicated-role depth also
apply to overrides.

## New agents and rework

`server/qualification.ts` exposes `qualificationForNewAgent(task, review,
config, matrixDefaultTier)` for the combined router. Pass the matrix's default
tier so untyped cards use the router's tier rather than the L2 fallback.
`review=true` means the automatic review of an
execution delivery; that review starts with reworkCount=0 and does not inherit
the executor's max tag or explicit effort. A standalone review uses its own
return count and effort/tag, which can authorize max.

`qualificationReworkCount` counts this card's `request_changes` or acceptance
`rejected` events that actually transition to rework, plus `leader_rework` events,
including those with
`countRound=false`. A stopped return followed by leader continuation before the next
start/resume counts once. It does not derive the count from runs or `review_round`.
Linked-review bookkeeping that ends the review card, land conflicts, start
retries and resume events do not count as review returns.

The combined router must call the adapter when opening a fresh agent, including
a replacement after rework. Intersect its output with eligible live matrix
profiles, supported provider depths and review-model isolation before ranking
pools. Reuse of the original agent retains that session's established depth.
The [combined quota router](QUOTA-ROUTING.md) now calls this adapter throughout
the scheduler and fresh-agent start paths.
