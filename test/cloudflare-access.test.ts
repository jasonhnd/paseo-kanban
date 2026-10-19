import assert from "node:assert/strict";
import { test } from "node:test";
import { commandAllowed, parseStatusOutput, STATUS_COMMANDS, type StatusOutcome } from "../shared/fleet/access-parse";
import { buildAccessView, parseAccessMap } from "../shared/fleet/access";
import { t } from "../shared/fleet/i18n";
import { t as boardT } from "../shared/i18n";
import { shellActions } from "../server/reclaim-actions";

const outcome = (patch: Partial<StatusOutcome> = {}): StatusOutcome => ({
  ok: true, stdout: "", stderr: "", timedOut: false, missing: false, abortedLogin: false, ...patch,
});
const user = {
  id: "demo-user", email: "demo@example.com", username: "demo-user",
  organizations: [{ id: "demo-organization", name: "Demo organization", permissions: ["demo-read"], roles: ["demo-role"] }],
};
const parse = (patch: Partial<StatusOutcome>) => parseStatusOutput("cloudflare-cf", outcome(patch));
const service = (id: string, check: unknown) => ({ id, name: "Demo Cloudflare", check });
const legacyCommand = { bin: "wrangler", args: ["whoami", "--json"] };
const oldCfCommand = { bin: "cf", args: ["auth", "whoami"] };

test("Cloudflare allows only the official read-only cf user command", () => {
  assert.deepEqual(STATUS_COMMANDS["cloudflare-cf"], { bin: "cf", args: ["user", "get"] });
  assert.equal(commandAllowed("cf", ["user", "get"]), true);
  for (const args of [["user", "edit"], ["user", "get", "--profile", "demo"], oldCfCommand.args]) {
    assert.equal(commandAllowed("cf", args), false);
  }
  assert.equal(commandAllowed(legacyCommand.bin, legacyCommand.args), false);
  assert.equal(Object.hasOwn(STATUS_COMMANDS, "cloudflare-wrangler"), false);
});

test("cf direct user JSON yields the account and organization names, never IDs or permissions", () => {
  const row = parse({ stdout: JSON.stringify(user) });
  assert.deepEqual(row, {
    state: "in", account: t("access.account.withNote", { account: user.email, note: "Demo organization" }),
    scopeCount: null, detail: null,
  });
  for (const value of [user.id, "demo-organization", "demo-read", "demo-role"]) assert.equal(JSON.stringify(row).includes(value), false);
  assert.equal(parse({ stdout: JSON.stringify({ username: "demo-user" }) }).account, "demo-user");
});

test("cf missing and invalid authentication are logged out", () => {
  for (const stderr of [
    "No authentication token found. Please run 'cf auth login'.",
    "Not authenticated", "Not logged in", "Authentication error", "Invalid API Token", "401 Unauthorized",
  ]) assert.deepEqual(parse({ ok: false, stderr }), { state: "out", account: null, scopeCount: null, detail: null });
});

test("cf missing command, timeouts, malformed JSON and other failures stay unknown", () => {
  assert.deepEqual(parse({ ok: false, missing: true }), {
    state: "unknown", account: null, scopeCount: null, detail: t("access.detail.commandMissing"),
  });
  assert.equal(parse({ timedOut: true }).state, "unknown");
  for (const stdout of ["", "not json", "{}", "[]", '{"id":"demo-user"}']) assert.equal(parse({ stdout }).state, "unknown");
  const failed = parse({ ok: false, stdout: JSON.stringify(user), stderr: "Permission denied" });
  assert.equal(failed.state, "unknown");
  assert.equal(failed.account, null);
  assert.equal(failed.detail, t("access.detail.commandFailed"));
  for (const value of [user.id, user.email, "demo-organization"]) assert.equal(JSON.stringify(failed).includes(value), false);
});

test("cf account output drops token-like fields", () => {
  const row = parse({ stdout: JSON.stringify({ ...user, email: "Bearer demo-secret", username: "ghp_demo-secret", organizations: [{ name: "gho_demo-secret" }] }) });
  assert.equal(row.state, "unknown");
  assert.equal(JSON.stringify(row).includes("demo-secret"), false);
});

test("stored Cloudflare maps normalize only exact retired checks in memory", () => {
  for (const [id, check] of [
    ["cloudflare-wrangler", legacyCommand], ["cloudflare-wrangler", oldCfCommand],
    ["cloudflare-cf", oldCfCommand], ["cloudflare-cf", STATUS_COMMANDS["cloudflare-cf"]],
  ] as const) {
    const raw = { services: [service(id, check)] };
    const before = JSON.stringify(raw);
    const [row] = parseAccessMap(raw);
    assert.equal(row?.id, "cloudflare-cf");
    assert.equal(row?.blocked, false);
    assert.deepEqual(row?.check, STATUS_COMMANDS["cloudflare-cf"]);
    assert.equal(JSON.stringify(raw), before);
  }
  for (const check of [
    { bin: "wrangler", args: ["deploy"] }, { ...legacyCommand, args: [...legacyCommand.args, "--extra"] },
    { bin: "cf", args: ["user", "edit"] }, { ...oldCfCommand, pluginId: "demo" },
  ]) assert.equal(parseAccessMap({ services: [service("cloudflare-wrangler", check)] })[0]?.blocked, true);
  assert.equal(parseAccessMap({ services: [service("vercel", legacyCommand)] })[0]?.blocked, true);
});

test("retired cache entries cannot report cf as authenticated", () => {
  const services = parseAccessMap({ services: [service("cloudflare-wrangler", legacyCommand)] });
  const stale = { "cloudflare-wrangler": { state: "in" as const, account: "demo@example.com", scopeCount: 5, detail: null } };
  const view = buildAccessView(services, [], stale, null, false, null);
  assert.equal(view.services[0]?.id, "cloudflare-cf");
  assert.equal(view.services[0]?.state, "unknown");
  assert.equal(view.services[0]?.accountLive, false);
});

test("stored duplicate Cloudflare entries prefer the canonical service in either order", () => {
  const current = service("cloudflare-cf", STATUS_COMMANDS["cloudflare-cf"]);
  const legacy = service("cloudflare-wrangler", legacyCommand);
  for (const services of [[legacy, current], [current, legacy]]) {
    const rows = parseAccessMap({ services });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.name, current.name);
    assert.deepEqual(rows[0]?.check, STATUS_COMMANDS["cloudflare-cf"]);
  }
});

test("reclaim recognizes cf and historical CLI operations without recording their arguments", () => {
  for (const bin of ["cf", "wrangler"]) {
    const expected = boardT("reclaimActions.tool.args", { label: bin });
    assert.deepEqual(shellActions(`${bin} workers deploy --name demo-private-resource`), [expected]);
    assert.deepEqual(shellActions(`/demo/bin/${bin} workers deploy --name demo-private-resource`), [expected]);
    assert.equal(expected.includes("demo-private-resource"), false);
  }
});
