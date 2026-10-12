// Exercise CLI language behavior with demo state only; protocol tokens stay language independent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseSetOutput, failureText } from "../roles-page";
import { setLanguage, tIn } from "../../../shared/fleet/i18n";

const plugin = resolve(import.meta.dirname, "../../..");
const roles = join(plugin, "bin/roles.mjs");
const supervisor = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const keys = ["supervisor", "executor", "reviewer", "reader", "decision", "batch", "ops_vercel", "ops_cloudflare", "ops_github", "ops_notion"];

function demo(setting: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "roles-language-"));
  const root = join(dir, "state");
  const state = join(root, "fleet");
  const paseo = join(dir, "paseo");
  const fakebin = join(dir, "bin");
  for (const path of [state, paseo, fakebin]) mkdirSync(path, { recursive: true });
  const write = (name: string, data: unknown) => writeFileSync(join(state, name), JSON.stringify(data));
  write("afc.config.json", { language: setting });
  write("decisions.json", []);
  write("plans.json", { plans: [{ id: "demo", name: "Demo pool", adapter: "manual", providers: ["codex", "claude"] }] });
  write("pool-status.json", { pools: { demo: { dispatchable: true, prefer: true } } });
  const config = join(paseo, "config.json");
  writeFileSync(config, JSON.stringify({ daemon: { agentProfiles: keys.map((role) => ({
    role, name: `Demo ${role}`, provider: role === "executor" ? "codex" : "claude",
    model: role === "executor" ? "gpt-6.1-sol" : "claude-sonnet-5-5", thinkingOptionId: "medium",
    family: role === "executor" ? "openai" : "anthropic", pool: "demo",
  })) }, plugins: { "agent-fleet-cockpit": { path: plugin } } }));
  const kanban = join(dir, "kanban.config.json");
  writeFileSync(kanban, JSON.stringify({ supervisors: { demo: supervisor } }));
  writeFileSync(join(fakebin, "paseo"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "provider" && args[1] === "ls") {
  console.log(JSON.stringify(["codex", "claude"].map(provider => ({ provider, status: "available" }))));
} else if (args[0] === "provider" && args[1] === "models") {
  console.log(JSON.stringify(["gpt-6.1-sol", "claude-sonnet-5-5", "demo-fast-model"].map(id => ({ id, thinkingOptionIds: ["medium", "high", "ultra"] }))));
} else if (args.length === 1 && args[0] === "reload") {
  const { appendFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  appendFileSync(join(process.env.PASEO_HOME, "demo-reloads.log"), "demo reload\\n", "utf8");
} else { console.error("unexpected fake Paseo command"); process.exitCode = 1; }
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, PASEO_HOME: paseo,
    ROLES_STATE_DIR: "", AFC_DATA_DIR: "", AFC_HOME: plugin,
    KANBAN_PASEO_CONFIG: config, ROLES_KANBAN_CONFIG: kanban, KANBAN_DATA_DIR: root, KANBAN_HOME: plugin,
    LANG: "C.UTF-8", LC_ALL: "", LC_MESSAGES: "", AFC_LANGUAGE: "",
    PATH: `${fakebin}:${process.env.PATH}` };
  function run(args: string[], override: NodeJS.ProcessEnv = {}) {
    const out = spawnSync(process.execPath, [roles, ...args], { env: { ...env, ...override }, encoding: "utf8", timeout: 30_000 });
    assert.equal(out.status, 0, `${args.join(" ")}: ${out.stderr}\n${out.stdout}`);
    return out.stdout;
  }
  return { dir, state, paseo, config, kanban, env, write, run };
}

function idFrom(text: string, token: string) {
  const id = new RegExp(`^${token} (\\S+)$`, "m").exec(text)?.[1];
  assert.ok(id, text);
  return id;
}

test("new AFC decisions use the configured default without relabeling explicit or historical projects", () => {
  const d = demo("en");
  try {
    const original = { id: "demo-historical", project: "paseo-fleet", title: "Demo historical decision", status: "open" };
    d.write("decisions.json", [original]);
    const add = (args: string[] = []) => idFrom(d.run(["decide", "add", "--title", "Demo choice", "--detail", "A: proceed; B: wait. Recommend: A", ...args]), "added");
    const defaultId = add();
    d.write("afc.config.json", { language: "en", opsProject: " Demo operations " });
    const configuredId = add();
    const explicitId = add(["--project", "demo"]);
    const decidedId = idFrom(d.run(["decide", "decided", "--title", "Demo", "--note", "Proceed"]), "decided");
    d.write("afc.config.json", { language: "en", opsProject: false });
    const fallbackId = add();
    const bytes = readFileSync(join(d.state, "decisions.json"), "utf8");
    for (const action of ["add", "decided"]) {
      const invalid = spawnSync(process.execPath, [roles, "decide", action, "--project", "", "--title", "Demo invalid", "--note", "Demo note", "--detail", "A: proceed; B: wait. Recommend: A"], { env: d.env, encoding: "utf8" });
      assert.equal(invalid.status, 1);
      assert.equal(readFileSync(join(d.state, "decisions.json"), "utf8"), bytes);
    }
    const rows = JSON.parse(readFileSync(join(d.state, "decisions.json"), "utf8"));
    assert.deepEqual(rows.find((row: any) => row.id === original.id), original);
    for (const [id, project] of [[defaultId, "paseo-fleet"], [configuredId, "Demo operations"], [explicitId, "demo"], [decidedId, "Demo operations"], [fallbackId, "paseo-fleet"]]) {
      assert.equal(rows.find((row: any) => row.id === id).project, project);
    }
    d.run(["decide", "done", original.id, "--note", "Demo resolved"]);
    assert.equal(JSON.parse(readFileSync(join(d.state, "decisions.json"), "utf8")).find((row: any) => row.id === original.id).project, "paseo-fleet");
  } finally { rmSync(d.dir, { recursive: true, force: true }); }
});

for (const lang of ["zh-CN", "en"] as const) {
  test(`roles set preserves host model features and configured exclusions in ${lang}`, () => {
    const d = demo(lang);
    const executor = () => JSON.parse(readFileSync(d.config, "utf8")).daemon.agentProfiles.find((p: { role: string }) => p.role === "executor");
    d.run(["set", "executor", "codex/demo-fast-model", "--thinking", "ultra", "--feature", "fast=true", "--feature", "fast_mode=true"]);
    assert.equal(executor().model, "demo-fast-model");
    assert.equal(executor().thinkingOptionId, "ultra");
    assert.deepEqual(executor().featureValues, { fast: true, fast_mode: true });
    d.run(["set", "executor", "codex/demo-fast-model"]);
    assert.deepEqual(executor().featureValues, { fast: true, fast_mode: true });
    assert.equal(readFileSync(join(d.paseo, "demo-reloads.log"), "utf8"), "demo reload\ndemo reload\n");

    d.write("afc.config.json", { language: lang, bannedProviders: ["codex"] });
    const before = readFileSync(d.config, "utf8");
    const refused = spawnSync(process.execPath, [roles, "set", "executor", "codex/demo-fast-model", "--force", "--dry-run"], {
      env: d.env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(refused.status, 1);
    assert.ok(refused.stderr.includes(tIn(lang, "roles.policy.refuseBannedProvider", { provider: "codex" })), refused.stderr);
    assert.equal(readFileSync(d.config, "utf8"), before);
  });
}

for (const lang of ["zh-CN", "en"] as const) {
  test(`all roles commands use ${lang} config under LANG=C.UTF-8`, () => {
    const d = demo(lang);
    const lineup = d.run(["ls"]);
    writeFileSync(join(d.dir, "ls.txt"), lineup);
    assert.match(lineup, new RegExp(`${tIn(lang, "dispatch.status.prefer")}`));
    assert.ok(lineup.includes("Demo executor"));
    // ROLES_STATE_DIR wins over AFC_DATA_DIR, and PASEO_HOME wins over HOME/.paseo.
    assert.ok(lineup.includes(tIn(lang, "dispatch.lineupItem", { name: "Demo executor", family: "openai", model: "gpt-6.1-sol", effort: "medium", pool: "demo", status: tIn(lang, "dispatch.status.prefer"), runs: 0 })), lineup);
    assert.match(d.run(["check"]), /\[OK\]/);
    assert.equal(d.run(["history"]), "");
    assert.equal(d.run(["pause", "ls"]).trim(), tIn(lang, "cli.roles.pauseNone"));
    assert.equal(d.run(["pause", "demo"]).trim(), "paused demo");
    assert.match(d.run(["pause", "ls"]), /^demo\t/);
    assert.equal(d.run(["resume", "demo"]).trim(), "resumed demo");
    const configBefore = readFileSync(d.config, "utf8");
    const swapped = d.run(["set", "executor", "codex/gpt-6.1-sol", "--thinking", "high", "--dry-run"]);
    assert.ok(swapped.includes(tIn(lang, "cli.roles.set.dryRun")));
    assert.deepEqual(parseSetOutput(swapped), {
      before: "codex/gpt-6.1-sol think=medium mode=-", after: "codex/gpt-6.1-sol think=high mode=-",
    });
    assert.equal(readFileSync(d.config, "utf8"), configBefore);
    const added = idFrom(d.run(["decide", "add", "--project", "demo", "--title", "Demo choice", "--detail", "A: proceed; B: wait. Recommend: A"]), "added");
    const decisions = d.run(["decide", "ls"]);
    writeFileSync(join(d.dir, "decide-ls.txt"), decisions);
    assert.ok(decisions.includes(tIn(lang, "cli.roles.waitedDays", { days: 0 })));
    assert.match(d.run(["decide", "comment", added, "--note", "Demo comment"]), new RegExp(`^commented ${added} 1`));
    assert.equal(d.run(["decide", "done", added, "--as", "shelved"]).trim(), `closed ${added} shelved`);
    assert.ok(d.run(["decide", "ls", "--all"]).includes(tIn(lang, "cli.roles.status.shelved")));
    assert.equal(d.run(["decide", "stale"]).trim(), tIn(lang, "cli.roles.staleNone", { days: 3 }));
    const decided = idFrom(d.run(["decide", "decided", "--project", "demo", "--title", "Demo", "--note", "Proceed"]), "decided");
    const reopened = idFrom(d.run(["decide", "overturn", decided]), "reopened");
    assert.ok(JSON.parse(readFileSync(join(d.state, "decisions.json"), "utf8")).some((item: { id: string; status: string }) => item.id === reopened && item.status === "open"));
    assert.match(d.run(["decide", "migrate"]), /^backup /);
    setLanguage(lang);
    assert.equal(failureText({ ok: false, stdout: "[FAIL] executor: demo\n[WARN] reviewer: demo\n", error: "roles: validation failed", timedOut: false, exitCode: 1 }), "[FAIL] executor: demo\n[WARN] reviewer: demo\nroles: validation failed");
  });
}

test("override, explicit system, invalid config and direct Node entry", () => {
  const d = demo("zh-CN");
  assert.ok(d.run(["ls"], { AFC_LANGUAGE: "en" }).includes("Executor:"));
  assert.ok(d.run(["ls"], { LANG: "POSIX" }).includes(tIn("zh-CN", "dispatch.status.prefer")));
  d.write("afc.config.json", { language: "en" });
  assert.ok(d.run(["ls"], { LANG: "zh_CN.UTF-8" }).includes("Executor:"));
  d.write("afc.config.json", { language: "system" });
  assert.ok(d.run(["ls"], { LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }).includes(tIn("zh-CN", "dispatch.status.prefer")));
  d.write("afc.config.json", { language: "invalid" });
  assert.ok(d.run(["ls"], { LANG: "zh_CN.UTF-8" }).includes(tIn("zh-CN", "dispatch.status.prefer")));
  assert.ok(d.run(["ls"], { LANG: "C.UTF-8", LC_ALL: "" }).includes("Executor:"));
  for (const lang of ["zh-CN", "en"] as const) {
    d.write("afc.config.json", { language: lang });
    const out = spawnSync(process.execPath, [roles, "ls"], {
      env: d.env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(tIn(lang, "dispatch.status.prefer")));
  }
});

test("maintenance parses actual closed/reopened output identically in both languages", async () => {
  const originalEnv = { ...process.env };
  const results: unknown[] = [];
  try {
    for (const lang of ["zh-CN", "en"] as const) {
      const d = demo(lang);
      Object.assign(process.env, d.env);
      setLanguage(lang);
      const { runDecisionMaintenance, performOverturn } = await import("../decisions-maint");
      const now = Date.now();
      d.write("decisions.json", [{ id: "demo-old", project: "demo", title: "Demo old decision",
        detail: "A: proceed; B: wait. Recommend: A", status: "open", blocking: false,
        createdAt: new Date(now - 9 * 86400_000).toISOString() }]);
      const noticeIds: string[] = [];
      const notify = async (id: string) => { noticeIds.push(id); };
      const maintained = await runDecisionMaintenance({ now, notify, paths: {
        decisionsPath: join(d.state, "decisions.json"), statePath: join(d.state, "maintenance.json"),
        logPath: join(d.state, "maintenance.log"), kanbanConfigPath: d.kanban,
        pausedPath: join(d.state, "paused-projects.json"), rolesBin: roles,
      } });
      const rows = () => JSON.parse(readFileSync(join(d.state, "decisions.json"), "utf8")) as Array<{ id: string; status: string }>;
      assert.equal(rows()[0].status, "shelved");
      assert.ok(maintained.logs.length > 0);
      const decided = idFrom(d.run(["decide", "decided", "--project", "demo", "--title", "Demo overturn", "--note", "Proceed"]), "decided");
      const overturned = await performOverturn({ id: decided, decisionsPath: join(d.state, "decisions.json"), kanbanConfigPath: d.kanban, notify });
      assert.equal(overturned.ok, true);
      assert.equal(overturned.notified, true);
      assert.ok(noticeIds.includes(supervisor));
      results.push({ shelved: rows()[0].status, overturned: rows().find((row) => row.id === decided)?.status,
        opened: rows().filter((row) => row.status === "open").length, ok: overturned.ok, notified: overturned.notified });
    }
    assert.deepEqual(results[0], results[1]);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
});


test("legacy files never override the explicit fresh root", () => {
  const d = demo("zh-CN");
  mkdirSync(join(d.dir, ".config"));
  symlinkSync(d.state, join(d.dir, ".config/fleet-roles"));
  const env = { ROLES_STATE_DIR: "", AFC_DATA_DIR: "" };
  assert.ok(d.run(["ls"], env).includes(tIn("zh-CN", "dispatch.status.prefer")));
  d.write("afc.config.json", { language: "en" });
  assert.ok(d.run(["ls"], env).includes("Executor:"));
});

test("answer changes parse the real added token identically in both languages", async () => {
  const { submitChange } = await import("../decide-change");
  const { decisionNote } = await import("../decide-reply");
  const results: unknown[] = [];
  for (const lang of ["zh-CN", "en"] as const) {
    const d = demo(lang);
    setLanguage(lang);
    const id = idFrom(d.run(["decide", "add", "--project", "demo", "--title", "Demo", "--detail", "A: proceed; B: wait. Recommend: A"]), "added");
    const note = decisionNote("A", "proceed");
    d.run(["decide", "done", id, "--note", note]);
    const result = await submitChange({ id, choice: "B", text: "" }, {
      readClosed: async () => ({ id, project: "demo", title: "Demo", detail: "A: proceed; B: wait. Recommend: A",
        note, doneAtMs: Date.now(), blocking: false, agentId: null, source: "Demo" }),
      now: Date.now, readOpen: async () => null, roles: async (args) => d.run(args),
      readTable: async () => null, listAgents: async () => [],
      send: async () => { throw new Error("No notification should be sent"); },
    });
    assert.equal(result.ok, true, result.message);
    assert.ok(result.newId);
    const rows = JSON.parse(readFileSync(join(d.state, "decisions.json"), "utf8")) as Array<{ id: string; status: string; note: string }>;
    const changed = rows.find((row) => row.id === result.newId);
    assert.equal(changed?.status, "done");
    assert.ok(changed?.note.includes("B"));
    results.push({ ok: result.ok, status: changed?.status });
  }
  assert.deepEqual(results[0], results[1]);
});
