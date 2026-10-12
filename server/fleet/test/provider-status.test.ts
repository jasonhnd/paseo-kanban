import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PaseoApi } from "../paseo-api";
import { setLanguage } from "../../../shared/fleet/i18n";
import type { Json } from "../util";

const root = await mkdtemp(join(tmpdir(), "provider-status-"));
for (const [key, dir] of Object.entries({ KANBAN_DATA_DIR: "afc", PASEO_HOME: "host",
   AFC_TRANSCRIPT_HOME: "transcripts",  })) process.env[key] = join(root, dir);
const { PLANS, buildUsage, refreshPoolStatus } = await import("../usage");
const { POOL_STATUS } = await import("../pools-status");
const { QUOTA_SAMPLING_FILE } = await import("../quota-sampling");
const { clearCache } = await import("../util");
const { quotaErrorText } = await import("../provider-usage");
after(() => rm(root, { recursive: true, force: true }));
setLanguage("en");
const now = Date.parse("2030-06-01T00:13:20Z");
const iso = (at: number) => new Date(at).toISOString();
const week = (usedPct = 53) => ({ id: "seven_day", label: "Weekly", usedPct, resetsAt: iso(now + 5 * 86400000) });

async function setup() {
  clearCache();
  await rm(join(process.env.KANBAN_DATA_DIR!, "fleet")!, { recursive: true, force: true });
  await mkdir(join(process.env.KANBAN_DATA_DIR!, "fleet")!, { recursive: true });
  await writeFile(join(join(process.env.KANBAN_DATA_DIR!, "fleet")!, "afc.config.json"), JSON.stringify({ adapters: {
    "grok-cli": false, "cursor-api": false, "antigravity-cli": false } }));
  const provider = (id: string, adapter: string, usageProvider: string, quotaProtection = "pause") => ({ id,
    name: id, adapter, usageProvider, providers: [usageProvider], dispatch: true, pacePause: false, couponCliRead: false,
    quotaCycle: { kind: "unknown" }, quotaProtection });
  await writeFile(PLANS, JSON.stringify({ plans: [
    provider("demo-claude", "claude-cli", "claude"), provider("demo-codex", "codex-cli", "codex"),
    provider("demo-none", "muse-msp", "muse", "none"),
    { ...provider("demo-manual", "manual", "claude"), manualOverride: { usedPct: 10, at: iso(now), ttlSeconds: 7200 } },
    { id: "demo-acp", name: "ACP", adapter: "antigravity-cli", providers: ["antigravity"],
      dispatch: true, pacePause: false, couponCliRead: false, quotaProtection: "pause" },
  ] }));
}

function host(report: Json): PaseoApi {
  return { providers: { listUsage: async () => ({ fetchedAt: iso(now - 2000), providers: [report,
    { providerId: "codex", status: "available", fetchedAt: iso(now - 3000), windows: [week(20)] },
    { providerId: "muse", status: "unavailable", windows: [] },
  ] }) } } as unknown as PaseoApi;
}

for (const status of ["available", "unavailable", "error"]) {
  test(`production board distinguishes ${status} with no windows without inventing a cause or source read`, async ctx => {
    ctx.mock.timers.enable({ apis: ["Date"], now });
    await setup();
    const paseo = host({ providerId: "claude", status, windows: [] });
    const board = await buildUsage(paseo, "7d");
    const primary = board.plans.find(p => p.id === "demo-claude")!.windows[0];
    assert.equal((primary as Json).providerStatus, status);
    assert.equal(primary.usedPct, null);
    assert.equal(primary.sampledAt, iso(now - 2000));
    assert.equal(primary.sourceTimeKind, "batch");
    if (status !== "available") assert.match(primary.readError!, new RegExp(status));
    const card = board.companies!.find(c => c.adapter === "claude-cli")!;
    assert.match(card.windows[0].sourceText, new RegExp(`Provider report status: ${status}\\b`));
    assert.doesNotMatch(card.windows[0].sourceText, /auth|login|expired|rate.limit/i);
    assert.equal(card.windows[0].readAt, null);
    assert.equal(board.pools!["demo-manual"].dispatchable, true);
    assert.equal(board.pools!["demo-codex"].dispatchable, true);
    assert.equal(board.pools!["demo-none"].dispatchable, true);
    assert.equal(board.pools!["demo-acp"].dispatchable, false);
    await refreshPoolStatus(paseo);
    const snapshot = JSON.parse(await readFile(POOL_STATUS, "utf8"));
    assert.equal(snapshot.pools["demo-codex"].usedPct, 20);
    ctx.mock.timers.reset();
  });
}

test("available windows retain the provider clock and status through assembly and publication", async ctx => {
  ctx.mock.timers.enable({ apis: ["Date"], now });
  await setup();
  const board = await buildUsage(host({ providerId: "claude", status: "available", fetchedAt: iso(now - 500), windows: [week()] }), "7d");
  const primary = board.plans.find(p => p.id === "demo-claude")!.windows[0];
  assert.equal((primary as Json).providerStatus, "available");
  assert.equal(primary.readError, null);
  assert.equal(primary.sampledAt, iso(now - 500));
  assert.equal(primary.sourceTimeKind, "source");
  assert.equal(board.companies!.find(c => c.adapter === "claude-cli")!.windows[0].readAt, iso(now - 500));
  const snapshot = JSON.parse(await readFile(POOL_STATUS, "utf8"));
  assert.equal(snapshot.pools["demo-claude"].observedAt, iso(now - 500));
  ctx.mock.timers.reset();
});

for (const status of ["available", "unavailable", "error"]) {
  test(`a supplied error wins over ${status} and is isolated without storing its raw sensitive text`, async ctx => {
    ctx.mock.timers.enable({ apis: ["Date"], now });
    await setup();
    const marker = "demo-sensitive-marker";
    const board = await buildUsage(host({ providerId: "claude", status, fetchedAt: iso(now - 500),
      error: { code: "rate_limit", message: "request rejected; authorization: " + marker }, windows: [week()] }), "7d");
    const primary = board.plans.find(p => p.id === "demo-claude")!.windows[0];
    assert.equal((primary as Json).providerStatus, status);
    assert.match(primary.readError!, /rate_limit/);
    assert.equal(primary.usedPct, null);
    assert.equal(board.pools!["demo-claude"].dispatchable, false);
    assert.match(board.companies!.find(c => c.adapter === "claude-cli")!.windows[0].sourceText, /rate_limit/);
    assert.equal(board.pools!["demo-codex"].dispatchable, true);
    assert.equal(board.pools!["demo-manual"].dispatchable, true);
    assert.doesNotMatch(JSON.stringify(board), new RegExp(marker));
    assert.doesNotMatch(await readFile(QUOTA_SAMPLING_FILE, "utf8"), new RegExp(marker));
    ctx.mock.timers.reset();
  });
}

test("full RPC failure retains the old source clock, consumes the slot and recovers on the next hourly slot", async ctx => {
  ctx.mock.timers.enable({ apis: ["Date"], now });
  await setup();
  let calls = 0;
  const marker = "demo-sensitive-marker";
  const paseo = { providers: { listUsage: async () => {
    if (++calls === 2) throw Object.assign(new Error("rate_limit; authorization: " + marker), { code: "rate_limit" });
    return { providers: [{ providerId: "claude", status: "available", fetchedAt: iso(Date.now() - 500), windows: [week()] },
      { providerId: "codex", status: "available", fetchedAt: iso(Date.now() - 500), windows: [week(20)] }] };
  } } } as unknown as PaseoApi;
  const first = await buildUsage(paseo, "7d");
  assert.equal(first.pools!["demo-claude"].dispatchable, true);
  ctx.mock.timers.setTime(now + 3600000);
  const failed = await buildUsage(paseo, "7d");
  assert.equal(failed.plans.find(p => p.id === "demo-claude")!.windows[0].sampledAt, iso(now - 500));
  for (const id of ["demo-claude", "demo-codex"]) {
    assert.equal(failed.pools![id].dispatchable, false);
    assert.match(failed.pools![id].reason, /rate_limit/);
  }
  assert.equal(failed.pools!["demo-manual"].dispatchable, true);
  // Existing policy: explicit RPC rate-limit evidence also holds provider pools with protection=none.
  assert.equal(failed.pools!["demo-none"].dispatchable, false);
  assert.doesNotMatch(await readFile(QUOTA_SAMPLING_FILE, "utf8"), new RegExp(marker));
  await refreshPoolStatus(paseo);
  assert.equal(calls, 2);
  ctx.mock.timers.setTime(now + 7200000);
  const recovered = await buildUsage(paseo, "7d");
  assert.equal(calls, 3);
  assert.equal(recovered.pools!["demo-claude"].dispatchable, true);
  assert.equal(recovered.pools!["demo-codex"].dispatchable, true);
  assert.equal(recovered.plans.find(p => p.id === "demo-claude")!.windows[0].readError, null);
  ctx.mock.timers.reset();
});

test("error categories do not mistake an authorization field for an authentication failure", () => {
  assert.equal(quotaErrorText({ code: "rate_limit", message: "authorization: demo-sensitive-marker" }), "rate_limit");
  assert.equal(quotaErrorText("transport interrupted; authorization: demo-sensitive-marker"), "transport");
  assert.equal(quotaErrorText("arbitrary private diagnostic demo-sensitive-marker"), "Provider usage failed");
  assert.equal(quotaErrorText({ code: "unauthorized" }), "authentication");
});

test("invalid provider clocks and unrecognized status text are never repaired or published", async ctx => {
  ctx.mock.timers.enable({ apis: ["Date"], now });
  for (const fetchedAt of ["bad", iso(now + 1000)]) {
    await setup();
    const board = await buildUsage(host({ providerId: "claude", status: "available", fetchedAt, windows: [week()] }), "7d");
    const primary = board.plans.find(p => p.id === "demo-claude")!.windows[0];
    assert.equal(primary.sampledAt, null);
    assert.equal(primary.sourceTimeKind, "unknown");
    assert.equal(board.companies!.find(c => c.adapter === "claude-cli")!.windows[0].readAt, null);
  }
  await setup();
  const marker = "demo-sensitive-marker";
  const board = await buildUsage(host({ providerId: "claude", status: marker, windows: [] }), "7d");
  assert.equal((board.plans.find(p => p.id === "demo-claude")!.windows[0] as Json).providerStatus, undefined);
  assert.doesNotMatch(JSON.stringify(board), new RegExp(marker));
  assert.doesNotMatch(await readFile(QUOTA_SAMPLING_FILE, "utf8"), new RegExp(marker));
  ctx.mock.timers.reset();
});

test("a synchronous RPC error is sanitized before entering the durable sample", async ctx => {
  ctx.mock.timers.enable({ apis: ["Date"], now });
  await setup();
  const marker = "demo-sensitive-marker";
  const paseo = { providers: { listUsage: () => { throw new Error("transport interrupted; authorization: " + marker); } } } as unknown as PaseoApi;
  const board = await buildUsage(paseo, "7d");
  assert.match(board.companies!.find(c => c.adapter === "claude-cli")!.windows[0].sourceText, /transport/);
  assert.equal(board.pools!["demo-manual"].dispatchable, true);
  assert.equal(board.pools!["demo-none"].dispatchable, true);
  assert.doesNotMatch(await readFile(QUOTA_SAMPLING_FILE, "utf8"), new RegExp(marker));
  ctx.mock.timers.reset();
});

test("explicit auth error codes keep the existing provider safety stop even with protection=none", async ctx => {
  ctx.mock.timers.enable({ apis: ["Date"], now });
  await setup();
  const marker = "demo-sensitive-marker";
  const paseo = { providers: { listUsage: async () => {
    throw Object.assign(new Error("authorization: " + marker), { code: "auth_expired" });
  } } } as unknown as PaseoApi;
  const board = await buildUsage(paseo, "7d");
  assert.equal(board.pools!["demo-none"].dispatchable, false);
  assert.match(board.pools!["demo-none"].reason, /authentication/);
  assert.equal(board.pools!["demo-manual"].dispatchable, true);
  assert.doesNotMatch(await readFile(QUOTA_SAMPLING_FILE, "utf8"), new RegExp(marker));
  assert.equal(quotaErrorText({ code: "AUTH_EXPIRED" }), "authentication");
  ctx.mock.timers.reset();
});

test("a fresh manual fallback keeps its own source time and freshness while showing the failed provider status", async ctx => {
  ctx.mock.timers.enable({ apis: ["Date"], now });
  await setup();
  const file = JSON.parse(await readFile(PLANS, "utf8"));
  file.plans[0].quotaCycle = { kind: "week", weekday: 6, timeZone: "UTC", hour: 0, minute: 0 };
  file.plans[0].manualOverride = { usedPct: 10, at: iso(now - 120000), ttlSeconds: 7200 };
  await writeFile(PLANS, JSON.stringify(file));
  const board = await buildUsage(host({ providerId: "claude", status: "unavailable", windows: [] }), "7d");
  const primary = board.plans.find(p => p.id === "demo-claude")!.windows[0];
  assert.equal(primary.source, "manual");
  assert.equal(primary.usedPct, 10);
  assert.equal(board.pools!["demo-claude"].dispatchable, true);
  const card = board.companies!.find(c => c.adapter === "claude-cli")!;
  assert.equal(card.windows[0].readAt, iso(now - 120000));
  assert.equal(card.windows[0].readingState, "live");
  assert.equal(card.stale, false);
  assert.match(card.windows[0].sourceText, /Copied by hand/);
  assert.match(card.windows[0].sourceText, /Provider report status: unavailable/);
  ctx.mock.timers.reset();
});

test("legacy empty/conflicting reports carry status hints without inventing a quota window", async ctx => {
  ctx.mock.timers.enable({ apis: ["Date"], now });
  for (const status of ["available", "unavailable", "error"]) {
    await setup();
    const file = JSON.parse(await readFile(PLANS, "utf8"));
    delete file.plans[0].quotaCycle;
    delete file.plans[0].quotaProtection;
    await writeFile(PLANS, JSON.stringify(file));
    const board = await buildUsage(host({ providerId: "claude", status, windows: status === "error" ? [week()] : [] }), "7d");
    const row = board.plans.find(p => p.id === "demo-claude")!.windows[0];
    assert.equal((row as Json).providerStatus, status);
    assert.equal(row.usedPct, null);
    const card = board.companies!.find(c => c.adapter === "claude-cli")!;
    assert.equal(card.windows[0].usedPct, null);
    assert.match(card.windows[0].sourceText, new RegExp(`Provider report status: ${status}\\b`));
    assert.equal(card.windows[0].readAt, null);
  }
  ctx.mock.timers.reset();
});

test("a first RPC failure has no fabricated clock/status and provider recovery clears its hint only in the next slot", async ctx => {
  ctx.mock.timers.enable({ apis: ["Date"], now });
  await setup();
  let calls = 0;
  const paseo = { providers: { listUsage: async () => {
    calls++;
    if (calls === 1) throw new Error("transport interrupted");
    return { providers: [{ providerId: "claude", status: calls === 2 ? "unavailable" : "available",
      windows: calls === 2 ? [] : [week()], fetchedAt: calls === 2 ? null : iso(Date.now() - 1000) }] };
  } } } as unknown as PaseoApi;
  const failed = await buildUsage(paseo, "7d");
  const primary = failed.plans.find(p => p.id === "demo-claude")!.windows[0];
  assert.equal(primary.sampledAt, null);
  assert.equal((primary as Json).providerStatus, undefined);
  assert.match(failed.companies!.find(c => c.adapter === "claude-cli")!.windows[0].sourceText, /transport/);
  assert.equal(failed.pools!["demo-none"].dispatchable, true);
  ctx.mock.timers.setTime(now + 3600000);
  const unavailable = await buildUsage(paseo, "7d");
  assert.match(unavailable.plans.find(p => p.id === "demo-claude")!.windows[0].readError!, /unavailable/);
  ctx.mock.timers.setTime(now + 3600000 + 60000);
  await refreshPoolStatus(paseo);
  assert.equal(calls, 2);
  ctx.mock.timers.setTime(now + 7200000);
  const recovered = await buildUsage(paseo, "7d");
  assert.equal(calls, 3);
  assert.equal(recovered.plans.find(p => p.id === "demo-claude")!.windows[0].readError, null);
  assert.equal(recovered.pools!["demo-claude"].dispatchable, true);
  assert.doesNotMatch(recovered.companies!.find(c => c.adapter === "claude-cli")!.windows[0].sourceText, /unavailable|transport/);
  ctx.mock.timers.reset();
});
