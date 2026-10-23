/// <reference types="node" />
// The standalone roles command uses the same catalogs, dispatch order and policy as the plugin.
import { assertTestSafePath } from "../storage/test-safety";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { currentRoleLines } from "./dispatch";
import { initLanguage } from "./language";
import { dataDir, kanbanConfigPath, paseoConfigPath } from "./paths";
import { readBannedProviders, readOpsProject } from "./adapters/config";
import { providerBanned } from "../../shared/fleet/provider-policy";
import { swapRefusal } from "../../shared/fleet/roles-policy";
import { actualModel, differentReviewModels } from "../../shared/fleet/review-model";
import { t, tIn, type MessageKey } from "../../shared/fleet/i18n";
import { commandPath } from "./platform";

type Row = Record<string, any>;
const STATE = dataDir();
const CONFIG = paseoConfigPath();
const DECISIONS = join(STATE, "decisions.json");
const PAUSED = join(STATE, "paused-projects.json");
const BACKUPS = join(STATE, "backups");
const ROLES = ["supervisor", "executor", "reviewer", "reader", "decision", "batch", "ops_vercel", "ops_cloudflare", "ops_github", "ops_notion"];
const STATUSES = ["open", "done", "supervisor", "stale", "shelved", "rewritten", "overturned"];
const CLOSE: Record<string, string> = { decided: "done", supervisor: "supervisor", stale: "stale", shelved: "shelved", rewritten: "rewritten" };
const DAY = 86400_000;
const stored = (key: string, values: Record<string, string | number> = {}) => tIn("zh-CN", key as MessageKey, values);
const allText = (key: string) => [tIn("en", key as MessageKey), tIn("zh-CN", key as MessageKey)];
const localized = (key: string, values: Record<string, string | number> = {}) => t(key as MessageKey, values);
const fail = (key: string, values: Record<string, string | number> = {}): never => { throw new Error(t(key as MessageKey, values)); };
function read(path: string, fallback?: any): any {
  assertTestSafePath(path);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}
function atomic(path: string, value: unknown) {
  assertTestSafePath(path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value, null, 2)); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
function list(): Row[] {
  let rows: unknown;
  try { rows = read(DECISIONS, []); } catch (error) { return fail("cli.roles.decideUnreadable", { error: String(error) }); }
  if (!Array.isArray(rows)) fail("cli.roles.decideNotList");
  return rows as Row[];
}
async function mutate<T>(work: (rows: Row[]) => T): Promise<T> {
  assertTestSafePath(STATE);
  assertTestSafePath(DECISIONS);
  mkdirSync(STATE, { recursive: true });
  const lock = `${DECISIONS}.lock`;
  const deadline = Date.now() + 10_000;
  let fd: number;
  for (;;) {
    try { fd = openSync(lock, "wx", 0o644); writeFileSync(fd, String(process.pid)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = Number(readFileSync(lock, "utf8"));
        let alive = false;
        if (Number.isInteger(owner) && owner > 0) { try { process.kill(owner, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; } }
        if (!alive && Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (Date.now() >= deadline) fail("cli.roles.decideBusy");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const stamp = () => { try { const s = statSync(DECISIONS, { bigint: true }); return `${s.mtimeNs}:${s.size}`; } catch { return "absent"; } };
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = stamp(), rows = list(), result = work(rows);
      if (stamp() !== before) continue;
      atomic(DECISIONS, rows);
      return result;
    }
    return fail("cli.roles.decideRaced");
  } finally { closeSync(fd!); unlinkSync(lock); }
}
const age = (row: Row) => Date.now() - Date.parse(row.createdAt);
const days = (row: Row) => Math.max(0, Math.floor(age(row) / DAY));
function newId(rows: Row[]) {
  const now = new Date(), pad = (n: number) => String(n).padStart(2, "0");
  const base = `d${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let n = 1; while (rows.some(row => row.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}
function leaders(): Row {
  const path = process.env.ROLES_KANBAN_CONFIG || kanbanConfigPath();
  assertTestSafePath(path);
  try { return read(path).supervisors || {}; } catch { return {}; }
}
function leader(project: string): string | null {
  const table = leaders();
  const key = Object.keys(table).find(key => key.toLowerCase() === project.toLowerCase() && typeof table[key] === "string" && table[key].trim());
  return key ? table[key].trim() : null;
}
function owner(project: string, persist = false) {
  return (persist ? stored : localized)(leader(project) ? "cli.roles.ownerLeader" : "cli.roles.ownerNone", { project });
}
function noteStatus(note: string): string {
  for (const status of ["supervisor", "stale", "shelved", "rewritten"]) if (allText(`cli.roles.notePrefix.${status}`).some(prefix => note.trimStart().startsWith(prefix))) return status;
  return "done";
}
function paused(): Row[] {
  try { const rows = read(PAUSED, []); return Array.isArray(rows) ? rows : []; }
  catch (error) { return fail("cli.roles.pauseUnreadable", { error: String(error) }); }
}
const isPaused = (project: string) => paused().some(row => row.project?.trim().toLowerCase() === project.trim().toLowerCase());
function required(value: string | undefined, key: string): string { if (!value) fail(key); return value!; }
function validDetail(detail: string) {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = escape(allText("cli.roles.optionMarkBefore").join("")), after = escape(allText("cli.roles.optionMarkAfter").join(""));
  const marks = [...detail.matchAll(new RegExp(`(?:^|[\\s${before}])([A-Da-d])(?=[.${after}\\s])`, "g"))].map(m => m[1].toUpperCase());
  return marks.includes("A") && marks.includes("B") && allText("cli.roles.recommendWord").some(word => detail.includes(word));
}
async function decide(action: string, id: string | undefined, v: Row) {
  const now = () => new Date().toISOString();
  const find = (rows: Row[]) => rows.find(row => row.id === id) || fail("cli.roles.noItem", { id: id || "" });
  if (action === "ls" || action === "stale") {
    const threshold = Number(v.days ?? 3);
    if (!Number.isInteger(threshold) || threshold < 0) fail("cli.roles.staleDays");
    const rows = list().filter(row => action === "ls" ? v.all || row.status === "open" : row.status === "open" && !row.blocking && age(row) > threshold * DAY);
    if (v.json) { console.log(JSON.stringify(rows)); return; }
    if (action === "stale") {
      if (!rows.length) console.log(t("cli.roles.staleNone", { days: threshold }));
      for (const project of [...new Set(rows.map(row => row.project || "?"))].sort()) {
        console.log(`[${project}] <leader> ${leader(project) || t("cli.roles.unregistered")}`);
        for (const row of rows.filter(row => (row.project || "?") === project).sort((a, b) => age(b) - age(a) || String(a.id).localeCompare(String(b.id)))) {
          console.log(t("cli.roles.staleRow", { id: row.id, days: days(row), title: row.title }));
        }
      }
      return;
    }
    for (const row of rows) {
      const waited = Number.isFinite(days(row)) ? t("cli.roles.waitedDays", { days: days(row) }) : t("cli.roles.waitedUnknown");
      console.log(`${row.id} ${row.blocking ? "!" : " "} [${row.project}] ${row.title} ${waited}${v.all ? ` ${localized(`cli.roles.status.${row.status}`)}` : ""} owner=${owner(row.project)} · ${owner(row.project)}${row.forceOpen ? t("cli.roles.forceOpenTag") : ""}`);
    }
    return;
  }
  if (action === "add" || action === "decided") {
    // Only new records use this default; existing records keep their stored project.
    v.project ??= readOpsProject(STATE);
    required(v.project, action === "add" ? "cli.roles.addRequired" : "cli.roles.decidedRequired");
    required(v.title, action === "add" ? "cli.roles.addRequired" : "cli.roles.decidedRequired");
    if (action === "decided") required(v.note?.trim(), "cli.roles.decidedNoteRequired");
    if (action === "add" && !v["force-open"] && !validDetail(v.detail || "")) fail("cli.roles.detailNeedsOptions");
    const result = await mutate(rows => {
      const stamp = now(), id = newId(rows);
      rows.push({ id, project: v.project, title: v.title, detail: action === "add" ? v.detail || "" : v.note,
        blocking: action === "add" && Boolean(v.blocking), agentId: v.agent?.length >= 32 && v.agent.includes("-") ? v.agent : null,
        source: v.source || stored("cli.roles.sourceLeader"), createdAt: stamp,
        ...(action === "add" ? { status: "open", owner: owner(v.project, true), forceOpen: Boolean(v["force-open"]) } : { status: "supervisor", doneAt: stamp, note: v.note }) });
      return id;
    });
    if (action === "add" && isPaused(v.project) && !v.force) console.error(t("cli.roles.pausedWarning", { project: v.project }));
    console.log(v.json ? JSON.stringify({ id: result }) : `${action === "add" ? "added" : "decided"} ${result}`); return;
  }
  if (action === "migrate") {
    await mutate(rows => {
      if (!existsSync(DECISIONS)) fail("cli.roles.migrateNone");
      assertTestSafePath(BACKUPS);
      mkdirSync(BACKUPS, { recursive: true });
      const backup = join(BACKUPS, `decisions-${Date.now()}-${randomUUID()}.json`);
      copyFileSync(DECISIONS, backup);
      const counts = () => STATUSES.map(s => `${s}=${rows.filter(row => row.status === s).length}`).join(" ");
      const before = counts(); let changed = 0;
      for (const row of rows) if (row.status === "done" && noteStatus(row.note || "") !== "done") { row.status = noteStatus(row.note || ""); changed++; }
      console.log(`backup ${backup}\nbefore ${before}\nafter ${counts()}\nchanged ${changed}`);
    }); return;
  }
  if (!["done", "reopen", "comment", "overturn"].includes(action)) throw new Error(`Unknown decision command: ${action}`);
  required(id, `cli.roles.${action === "overturn" ? "overturn" : action}IdRequired`);
  if (action === "comment") required(v.note?.trim(), "cli.roles.commentNoteRequired");
  if (v.as && !(v.as in CLOSE)) throw new Error("Invalid --as status");
  const result = await mutate(rows => {
    const row = find(rows);
    if (action === "done") {
      if (v["auto-shelve"] && (row.status !== "open" || row.blocking || !Number.isFinite(age(row)) || age(row) < 7 * DAY)) return "skipped";
      const status = v.as ? CLOSE[v.as] : noteStatus(v.note || "");
      // Repeating the same close must preserve the original timestamp.
      if (!v["auto-shelve"] && row.status === status && (row.note || "") === (v.note || "")) return status;
      row.status = status; row.doneAt = now(); row.note = v.note || ""; return row.status;
    }
    if (action === "reopen") {
      if (row.status === "open") return "open";
      if (row.status !== "done" || !allText("decisions.reply.userDismissNote").includes(row.note || "")) fail("cli.roles.reopenNotPanel", { id: id! });
      row.status = "open"; delete row.doneAt; row.note = ""; return "open";
    }
    if (action === "comment") { if (!Array.isArray(row.userComments)) row.userComments = []; row.userComments.push({ at: now(), note: v.note.trim() }); return row.userComments.length; }
    if (row.status !== "supervisor") fail("cli.roles.notSupervisor", { id: id!, status: row.status });
    row.status = "overturned"; row.overturnedAt = now(); if (v.note) row.overturnNote = v.note;
    const body = [v.note?.trim(), row.note?.trim()].filter(Boolean).join(stored("cli.roles.overturnJoin")) || row.title;
    const next = newId(rows); rows.push({ id: next, project: row.project, title: row.title, detail: stored("cli.roles.overturnDetail", { body }),
      blocking: Boolean(row.blocking), agentId: row.agentId, source: row.source || stored("cli.roles.sourceLeader"), createdAt: now(), status: "open" }); return next;
  });
  console.log(action === "done" ? `closed ${id} ${result}` : action === "reopen" ? `reopened ${id} ${result}` : action === "comment" ? `commented ${id} ${result}` : `overturned ${id}\nreopened ${result}`);
}
function paseo(...args: string[]): any {
  const out = spawnSync("paseo", args, { encoding: "utf8", env: { ...process.env, PATH: commandPath() }, timeout: 30_000 });
  if (out.status !== 0 || out.error) return null;
  try { return JSON.parse(out.stdout); } catch { return null; }
}
const family = (p: string, m: string): string | undefined => {
  for (const [hint, name] of [["claude", "anthropic"], ["gpt", "openai"], ["grok", "xai"], ["composer", "cursor"]]) if (m.toLowerCase().includes(hint)) return name;
  return ({ claude: "anthropic", codex: "openai", grok: "xai" } as Row)[p];
};
const label = (p: Row) => `${p.provider}/${p.model} think=${p.thinkingOptionId || "-"} mode=${p.modeId || "-"}${p.featureValues && Object.keys(p.featureValues).length ? ` [${Object.entries(p.featureValues).map(([k, v]) => `${k}=${v}`).join(",")}]` : ""}`;
const kv = (values: string[] = []) => Object.fromEntries(values.map(value => { const i = value.indexOf("="); if (i < 1) throw new Error("Expected key=value"); const text = value.slice(i + 1); return [value.slice(0, i), text === "true" ? true : text === "false" ? false : text]; }));
function validate(p: Row, providers: Row[]): string | null {
  const provider = providers.find(x => x.provider === p.provider);
  if (provider?.status !== "available") return t("cli.roles.check.providerDown", { provider: p.provider, status: provider?.status || "unknown" });
  const models = paseo("provider", "models", p.provider, "--thinking", "--json") || [];
  let model = Array.isArray(models) ? models.find((x: Row) => x.id === p.model) : null;
  if (!model && p.provider === "codex") {
    const out = spawnSync("codex", ["debug", "models"], { encoding: "utf8", env: { ...process.env, PATH: commandPath() }, timeout: 30_000 });
    try { const raw = JSON.parse(out.stdout); const found = (raw.models || raw).find((x: Row) => x.visibility === "list" && x.slug === p.model); if (found) model = { thinkingOptionIds: found.supported_reasoning_levels.map((x: Row) => x.effort) }; } catch { /* Unavailable catalog cannot validate a model. */ }
  }
  if (!model) return t("cli.roles.check.modelMissing", { model: p.model, provider: p.provider });
  if (p.thinkingOptionId && model.thinkingOptionIds?.length && !model.thinkingOptionIds.includes(p.thinkingOptionId)) return t("cli.roles.check.thinking", { thinking: p.thinkingOptionId, options: String(model.thinkingOptionIds) });
  return null;
}
function check(cfg: Row, extra?: Row, verbose = true): number {
  const profiles: Row[] = cfg.daemon?.agentProfiles || [], providers = paseo("provider", "ls", "--json") || [], banned = readBannedProviders(STATE);
  let problems = 0;
  const report = (role: string, message: string | null) => { if (message) problems++; if (message || verbose) console.log(`[${message ? "FAIL" : "OK"}] ${role}: ${message || "OK"}`); };
  for (const role of ROLES) {
    const p = profiles.find(p => p.role === role);
    report(role, !p ? t("cli.roles.check.noProfile") : providerBanned(p, banned) ? t("roles.policy.refuseBannedProvider", { provider: p.provider }) : validate(p, providers));
  }
  for (const p of profiles.filter(p => !ROLES.includes(p.role) && (p.role === "candidate" || p.candidateFor || p.pausedCandidateFor))) if (providerBanned(p, banned)) report(p.name, t("roles.policy.refuseBannedProvider", { provider: p.provider }));
  const maker = actualModel(profiles.find(p => p.role === "executor")?.model), checker = actualModel(profiles.find(p => p.role === "reviewer")?.model);
  report("executor+reviewer", !maker || !checker ? t("cli.roles.check.reviewModelMissing") :
    !differentReviewModels(maker, checker) ? t("cli.roles.check.sameModel", { model: maker }) : null);
  if (extra && !ROLES.includes(extra.role)) report(extra.name, validate(extra, providers));
  return problems;
}
async function run(argv: string[]) {
  initLanguage(STATE);
  const stringOptions = ["thinking", "mode", "family", "project", "title", "detail", "agent", "source", "note", "as", "days"];
  const booleanOptions = ["update-policy", "dry-run", "force", "force-open", "auto-shelve", "all", "json", "help"];
  const options: Record<string, any> = Object.fromEntries([...stringOptions.map(k => [k, { type: "string" }]), ...booleanOptions.map(k => [k, { type: "boolean" }]), ["feature", { type: "string", multiple: true }], ["param", { type: "string", multiple: true }]]);
  const { values, positionals: [command, first, second, ...extra] } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  const v: Row = values;
  if (v.help || !command) { console.log("usage: roles ls | check | history | set <role> <provider>/<model> [options] | decide add|ls|done|reopen|comment|decided|overturn|stale|migrate [options] | pause|resume <project>"); return; }
  if (extra.length) throw new Error("Unexpected positional arguments");
  if (command === "ls") { for (const line of await currentRoleLines()) console.log(line); return; }
  if (command === "history") { const path = join(STATE, "changes.log"); if (existsSync(path)) process.stdout.write(readFileSync(path, "utf8")); return; }
  if (command === "decide") return decide(first, second, v);
  if (command === "pause" || command === "resume") {
    const rows = paused();
    if (command === "pause" && first === "ls") { if (!rows.length) console.log(t("cli.roles.pauseNone")); for (const row of rows) console.log(`${row.project}\t${row.since || ""}\t${row.note || ""}`); return; }
    required(first, "cli.roles.projectRequired");
    const keep = rows.filter(row => row.project?.trim().toLowerCase() !== first.toLowerCase());
    if (command === "pause") { if (keep.length !== rows.length) fail("cli.roles.pauseAlready", { project: first }); keep.push({ project: first, since: new Date().toISOString(), note: v.note || "" }); }
    else if (keep.length === rows.length) fail("cli.roles.resumeNotPaused", { project: first });
    atomic(PAUSED, keep); console.log(`${command === "pause" ? "paused" : "resumed"} ${first}`); return;
  }
  const cfg = read(CONFIG);
  if (command === "check") { process.exitCode = check(cfg) ? 1 : 0; return; }
  if (command !== "set") throw new Error(`Unknown roles command: ${command}`);
  const profiles: Row[] = cfg.daemon?.agentProfiles || [];
  const key = first === "<leader>" ? "supervisor" : first;
  const p = profiles.find(p => (ROLES.includes(p.role) || p.role === "patrol") ? p.role === key || p.name === key : p.role === "candidate" && p.candidateFor && p.name === key);
  if (!p) fail("cli.roles.unknownRole", { key: key || "", known: ROLES.join(", "), cands: "" });
  const index = second?.indexOf("/") ?? -1;
  if (index < 1 || index === second.length - 1) fail("cli.roles.set.target");
  const provider = second.slice(0, index), model = second.slice(index + 1), before = label(p!);
  const refuse = swapRefusal(provider, model, v.thinking, readBannedProviders(STATE));
  if (refuse) throw new Error(refuse);
  const features = kv(v.feature);
  if (p!.provider !== provider) {
    if (!v.mode && p!.modeId !== undefined) { delete p!.modeId; console.log(t("cli.roles.set.droppedMode")); }
    if (!v.feature && p!.featureValues !== undefined) { delete p!.featureValues; console.log(t("cli.roles.set.droppedFeatures")); }
    if (p!.pool) {
      const plans = read(join(STATE, "plans.json"), {}).plans || [];
      const pool = plans.find((plan: Row) => plan.usageProvider === provider || plan.providers?.includes(provider))?.id;
      if (!pool) fail("cli.roles.set.noPool", { provider: `'${provider}'` });
      console.log(t("cli.roles.set.poolMoved", { old: p!.pool, new: pool })); p!.pool = pool;
    }
  }
  p!.provider = provider; p!.model = model;
  if (v.thinking !== undefined) p!.thinkingOptionId = v.thinking;
  if (v.mode !== undefined) p!.modeId = v.mode;
  if (v.feature) p!.featureValues = features;
  const inherited = swapRefusal(provider, model, p!.thinkingOptionId, readBannedProviders(STATE));
  if (inherited) throw new Error(inherited);
  p!.family = v.family || family(provider, model) || p!.family;
  const after = label(p!); console.log(`${p!.name} (${p!.role}): ${before}\n  -> ${after}  family=${p!.family}`);
  if (check(cfg, p!, false)) { if (!v.force) fail("cli.roles.set.validationFailed"); console.log(t("cli.roles.set.validationForced")); }
  if (v["dry-run"]) { console.log(t("cli.roles.set.dryRun")); return; }
  assertTestSafePath(BACKUPS);
  assertTestSafePath(CONFIG);
  assertTestSafePath(join(STATE, "changes.log"));
  mkdirSync(BACKUPS, { recursive: true }); copyFileSync(CONFIG, join(BACKUPS, `config-${Date.now()}-${randomUUID()}.json`));
  atomic(CONFIG, cfg);
  spawnSync("paseo", ["reload"], { encoding: "utf8", env: { ...process.env, PATH: commandPath() }, timeout: 30_000 });
  appendFileSync(join(STATE, "changes.log"), JSON.stringify({ at: new Date().toISOString(), role: p!.role, profile: p!.name, from: before, to: after, family: p!.family }, null, 1).replace(/\n/g, "") + "\n");
  console.log(t("cli.roles.set.written", { dir: BACKUPS }));
}
run(process.argv.slice(2)).catch(error => { console.error(String(error.message || error)); process.exitCode = 1; });
