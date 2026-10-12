import { getLanguage, setLanguage, translate, type Language } from "../shared/i18n";
import { applyServerLanguage } from "../server/language";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const initialLanguage = getLanguage();
const dir = mkdtempSync(join(tmpdir(), "quota-protection-"));
const previous = {
  AFC_DATA_DIR: process.env.AFC_DATA_DIR,
  ROLES_STATE_DIR: process.env.ROLES_STATE_DIR,
  KANBAN_DATA_DIR: process.env.KANBAN_DATA_DIR,
  PASEO_HOME: process.env.PASEO_HOME,
  KANBAN_POOL_STATUS: process.env.KANBAN_POOL_STATUS,
  KANBAN_LANGUAGE: process.env.KANBAN_LANGUAGE,
};
delete process.env.AFC_DATA_DIR;
delete process.env.ROLES_STATE_DIR;
process.env.KANBAN_DATA_DIR = join(dir, "board");
process.env.PASEO_HOME = join(dir, "host");
delete process.env.KANBAN_POOL_STATUS;
process.env.KANBAN_LANGUAGE = "en";
setLanguage("en");
mkdirSync(join(process.env.KANBAN_DATA_DIR, "exports", "fleet"), { recursive: true });
mkdirSync(process.env.KANBAN_DATA_DIR, { recursive: true });
writeFileSync(join(process.env.KANBAN_DATA_DIR, "kanban.config.json"), JSON.stringify({ projects: {}, families: {}, bannedProviders: [], disabledPools: [] }));

const { readCompatibilityPoolSnapshot: readPoolSnapshot, STALE_MS } = await import("../server/pools");
const { routeProfile } = await import("../server/routing");

after(() => {
  setLanguage(initialLanguage);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const now = Date.now();
const row = (changes: Record<string, unknown> = {}) => ({
  quotaProtection: "pause",
  readingExpiresAt: new Date(now + 60_000).toISOString(),
  usedPct: 12,
  dispatchable: true,
  deprioritize: false,
  prefer: false,
  resetsAt: null,
  onlyRoles: null,
  reason: "Demo reading",
  ...changes,
});

function publish(pools: Record<string, unknown>, generatedAt = now, extra: Record<string, unknown> = {}) {
  writeFileSync(join(process.env.KANBAN_DATA_DIR!, "exports/fleet/pool-status.json"), JSON.stringify({
    schema: "fleet-quota/v1",
    producer: "agent-fleet-cockpit",
    producerVersion: "demo",
    generatedAt: new Date(generatedAt).toISOString(),
    ttlSeconds: 600,
    quotaConfigured: true,
    priority: null,
    pools,
    ...extra,
  }));
}

test("fresh and stale exports cannot authorize an unknown or expired protected reading", () => {
  publish({
    "demo-fresh": row(),
    "demo-unknown": row({ usedPct: null, dispatchable: true, readingExpiresAt: null }),
    "demo-missing-expiry": row({ readingExpiresAt: undefined }),
    "demo-expired": row({ readingExpiresAt: new Date(now).toISOString() }),
    "demo-unprotected": row({ quotaProtection: "none", usedPct: null, readingExpiresAt: null }),
  });
  const fresh = readPoolSnapshot(now);
  assert.equal(fresh.state, "fresh");
  assert.equal(fresh.dispatchable("demo-fresh"), true);
  assert.equal(fresh.dispatchable("demo-unknown"), false);
  assert.equal(fresh.dispatchable("demo-missing-expiry"), false);
  assert.equal(fresh.entry("demo-expired").usedPct, null);
  assert.equal(fresh.dispatchable("demo-expired"), false);
  assert.equal(fresh.dispatchable("demo-unprotected"), true);

  publish({
    "demo-fresh": row(),
    "demo-blank": row({ usedPct: null, dispatchable: true }),
    "demo-unprotected": row({ quotaProtection: "none", usedPct: 99, dispatchable: false, prefer: true, deprioritize: true }),
  }, now - 3_600_000);
  const stale = readPoolSnapshot(now);
  assert.equal(stale.state, "stale");
  assert.equal(stale.dispatchable("demo-fresh"), false);
  assert.equal(stale.dispatchable("demo-blank"), false);
  assert.equal(stale.entry("demo-blank").usedPct, null);
  assert.equal(stale.dispatchable("demo-unprotected"), true);
  assert.equal(stale.entry("demo-unprotected").prefer, false);
  assert.equal(stale.entry("demo-unprotected").deprioritize, false);
  assert.equal(stale.dispatchable("not-in-file"), false);
  assert.equal(stale.dispatchable(null), true);
});

test("a fresh snapshot follows dispatchable unless a protected reading has expired", () => {
  publish({
    "fresh-open": row({ dispatchable: true, usedPct: 99 }),
    "fresh-closed": row({ dispatchable: false, usedPct: 1 }),
    "fresh-none-closed": row({ quotaProtection: "none", dispatchable: false, usedPct: null, readingExpiresAt: null }),
    "fresh-expired-blank": row({ dispatchable: true, usedPct: null, readingExpiresAt: new Date(now - 1_000).toISOString() }),
    "legacy-open": { dispatchable: true, deprioritize: true, prefer: true, usedPct: 99, resetsAt: null, onlyRoles: null, reason: "window" },
    "legacy-closed": { dispatchable: false, deprioritize: false, prefer: false, usedPct: null, resetsAt: null, onlyRoles: null, reason: "paused" },
  });
  const fresh = readPoolSnapshot(now);
  assert.equal(fresh.state, "fresh");
  assert.equal(fresh.dispatchable("fresh-open"), true);
  assert.equal(fresh.entry("fresh-open").usedPct, 99);
  assert.equal(fresh.dispatchable("fresh-closed"), false);
  assert.equal(fresh.entry("fresh-closed").reason, "Demo reading");
  assert.equal(fresh.dispatchable("fresh-none-closed"), false);
  assert.equal(fresh.dispatchable("fresh-expired-blank"), false);
  assert.equal(fresh.entry("fresh-expired-blank").usedPct, null);
  assert.equal(fresh.dispatchable("legacy-open"), true);
  assert.equal(fresh.entry("legacy-open").deprioritize, true);
  assert.equal(fresh.entry("legacy-open").prefer, true);
  assert.equal(fresh.entry("legacy-open").usedPct, 99);
  assert.equal(fresh.dispatchable("legacy-closed"), false);
  assert.equal(fresh.entry("legacy-closed").reason, "paused");
});

test("an old snapshot without quotaProtection keeps today's stale stop lines", () => {
  publish({
    "legacy-blank": { dispatchable: false, deprioritize: true, prefer: true, usedPct: null, resetsAt: null, onlyRoles: null, reason: "paused" },
    "legacy-low": { dispatchable: false, deprioritize: true, prefer: true, usedPct: 10, resetsAt: null, onlyRoles: null, reason: "paused" },
    "legacy-high": { dispatchable: true, deprioritize: false, prefer: true, usedPct: 99, resetsAt: null, onlyRoles: null, reason: null },
  }, now - 3_600_000, { quotaConfigured: undefined });
  const stale = readPoolSnapshot(now);
  assert.equal(stale.state, "stale");
  assert.equal(stale.dispatchable("legacy-blank"), true);
  assert.equal(stale.entry("legacy-blank").prefer, false);
  assert.equal(stale.entry("legacy-blank").deprioritize, false);
  assert.equal(stale.dispatchable("legacy-low"), true);
  assert.equal(stale.dispatchable("legacy-high"), false);
  assert.equal(stale.dispatchable("not-in-file"), true);
  assert.equal(stale.dispatchable(null), true);
});

test("zero configured pools pause obsolete bindings while profiles without pools remain usable", () => {
  publish({});
  const snapshot = readPoolSnapshot(now);
  assert.equal(snapshot.dispatchable("removed-demo-pool"), false);
  assert.match(snapshot.entry("removed-demo-pool").reason ?? "", /not configured/);
  assert.equal(snapshot.dispatchable(null), true);
});

for (const language of ["en", "zh-CN"] as const satisfies readonly Language[]) {
  test(`quota block reasons follow the board language setting: ${language}`, (context) => {
    context.after(() => setLanguage("en"));
    // A board setting must win over the OS locale; do not introduce a separate quota locale.
    assert.equal(applyServerLanguage({ LANG: "C.UTF-8" }, { language }), language);
    publish({ "demo-expired": row({ readingExpiresAt: new Date(now).toISOString() }) });
    const snapshot = readPoolSnapshot(now);
    assert.equal(snapshot.entry("demo-expired").reason, translate(language, "pools.readingExpired"));
    assert.equal(snapshot.entry("not-in-file").reason, translate(language, "pools.notConfigured"));
    assert.notEqual(snapshot.entry("demo-expired").reason, translate(language === "en" ? "zh-CN" : "en", "pools.readingExpired"));
    assert.notEqual(snapshot.entry("not-in-file").reason, translate(language === "en" ? "zh-CN" : "en", "pools.notConfigured"));
  });
}

test("quota reasons retain the public system-language fallback", (context) => {
  context.after(() => setLanguage("en"));
  assert.equal(applyServerLanguage({ LANG: "C.UTF-8" }, { language: "system" }), "en");
  publish({ "demo-expired": row({ readingExpiresAt: undefined }) });
  assert.equal(readPoolSnapshot(now).entry("demo-expired").reason, translate("en", "pools.readingExpired"));
});

test("a legacy file without the new fields still opens an unlisted pool", () => {
  const legacy = join(dir, "legacy-pool-status.json");
  writeFileSync(legacy, JSON.stringify({
    pools: { "legacy-open": { dispatchable: true, usedPct: 12, prefer: true } },
  }));
  const recent = new Date(now - 1_000);
  utimesSync(legacy, recent, recent);
  process.env.KANBAN_POOL_STATUS = legacy;
  const fresh = readPoolSnapshot(now);
  assert.equal(fresh.state, "fresh");
  assert.equal(fresh.dispatchable("legacy-open"), true);
  assert.equal(fresh.entry("legacy-open").prefer, true);
  assert.equal(fresh.dispatchable("unlisted"), true);
  const old = new Date(now - STALE_MS - 1_000);
  utimesSync(legacy, old, old);
  const stale = readPoolSnapshot(now);
  assert.equal(stale.state, "stale");
  assert.equal(stale.dispatchable("legacy-open"), true);
  assert.equal(stale.entry("legacy-open").prefer, false);
  assert.equal(stale.dispatchable("unlisted"), true);
  delete process.env.KANBAN_POOL_STATUS;
});

test("the actual router selects a healthy alternative and never treats an unknown pool as zero", () => {
  publish({
    "demo-unknown": row({ usedPct: null, dispatchable: false, readingExpiresAt: null }),
    "demo-healthy": row(),
  });
  const profiles = [
    { id: "demo-primary", name: "Demo primary", provider: "demo-provider", model: "demo-model", family: "demo-family", role: "executor", pool: "demo-unknown" },
    { id: "demo-alternative", name: "Demo alternative", provider: "demo-provider", model: "demo-model", family: "demo-family", role: "candidate", candidateFor: "executor", pool: "demo-healthy" },
    { id: "demo-review", name: "Demo review", provider: "demo-review-provider", model: "demo-review-model", family: "demo-review-family", role: "reviewer", pool: "demo-healthy" },
  ] as never;
  const choice = routeProfile({ profiles, role: "executor", review: false, byPool: {}, poolLimits: {}, snapshot: readPoolSnapshot(now), now });
  assert.equal(choice.ok, true, JSON.stringify(choice));
  if (choice.ok) assert.equal(choice.profile.id, "demo-alternative");
});
