# Unknown quota

A failed, missing or expired quota reading publishes `state: "unknown"` in
`fleet/pool-status.json` and the immutable policy snapshot. Unknown pools allow
at most one concurrent card, limited to L1/L2, across all profiles and roles on
that pool. Existing provider, authentication, quota protection, disabled-pool
and concurrency stops still apply. This does not change pool priority.

Configure the limits in `fleet/afc.config.json`:

```json
{
  "unknownQuota": {
    "maxAgeMs": 7200000,
    "maxConcurrent": 1,
    "tiers": ["L1", "L2"]
  }
}
```

The default maximum age is twice the hourly sampling interval. A source's
shorter safety deadline or reset still wins. Publication never refreshes the
source clock. Consumers check `quotaStateExpiresAt` at admission, including
immediately before creating an agent. A zero concurrency cap or empty tier list
closes unknown admission. Invalid settings retain the bounded defaults. Older
numeric compatibility rows without source-clock fields retain their existing
policy until the next collector observation.

The panel labels unknown pools as “Quota unknown” (Chinese: see the localized
catalog). AFC's heartbeat alerts registered project leaders once per pool and
recipient. `fleet/unknown-quota-notices.json` stores successful deliveries;
failed deliveries retry. A known reading clears the episode, allowing one new
alert if the pool becomes unknown again. Panel reads track recovery without
sending messages. No production configuration changes are needed to activate
the defaults after the code is installed.
