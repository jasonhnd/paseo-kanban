/// <reference types="node" />
// Read-only checks for `npm run compat`. Nothing here writes state or sends messages.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type MessageKey, t } from "../../shared/fleet/i18n";
import { parseDaemonRestartTimes, parseDaemonVersion } from "./daemon-log";
import { readAgentRecordFiles } from "./records";
import { BIN, type Json, runOutcome } from "./util";

const AGENT_KEYS = ["id", "title", "cwd", "labels", "updatedAt", "lastStatus", "provider", "archivedAt", "workspaceId"] as const;

export function pluginFromJson(value: unknown, id: string): { status: string; error: string } | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Json;
    if (row.id !== id) continue;
    const error = row.error ?? row.ERROR ?? "";
    return { status: String(row.status ?? row.state ?? ""), error: error == null ? "" : String(error).trim() };
  }
  return null;
}

/** Table fallback when `paseo plugin ls --json` is missing. ERROR is the last column. */
export function pluginRowFromTable(text: string, id: string): { status: string; error: string } | null {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  const header = lines.find((line) => line.includes("PLUGIN") && line.includes("STATUS") && line.includes("ERROR"));
  if (!header) return null;
  const statusAt = header.indexOf("STATUS");
  const enabledAt = header.indexOf("ENABLED");
  const errorAt = header.indexOf("ERROR");
  if (statusAt < 0 || errorAt < 0) return null;
  for (const line of lines) {
    if (!line.startsWith(id)) continue;
    const status = line.slice(statusAt, enabledAt > statusAt ? enabledAt : statusAt + 12).trim();
    const error = line.slice(errorAt).trim();
    return { status, error };
  }
  return null;
}

async function chunkHas(path: string, markers: string[]): Promise<boolean> {
  const st = await stat(path).catch(() => null);
  if (!st || st.size === 0) return false;
  const fh = await open(path, "r");
  try {
    const take = Math.min(st.size, 512_000);
    const head = Buffer.alloc(take);
    await fh.read(head, 0, take, 0);
    if (markers.every((m) => head.toString("utf8").includes(m))) return true;
    if (st.size > take) {
      const tail = Buffer.alloc(take);
      await fh.read(tail, 0, take, st.size - take);
      if (markers.every((m) => tail.toString("utf8").includes(m))) return true;
    }
    return false;
  } finally {
    await fh.close();
  }
}

async function sampleHas(dir: string, depth: number, accept: (path: string) => boolean, markers: string[]): Promise<"skip" | "ok" | "bad"> {
  const best = { path: "", size: -1 };
  const consider = async (path: string) => {
    const st = await stat(path).catch(() => null);
    if (!st) return;
    if (st.size > best.size) {
      best.path = path;
      best.size = st.size;
    }
  };
  const walk = async (current: string, left: number): Promise<void> => {
    if (left < 0) return;
    let ents;
    try {
      ents = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[afc] compat: cannot read directory", current, String(error).slice(0, 120));
      return;
    }
    for (const ent of ents) {
      const full = join(current, ent.name);
      if (ent.isDirectory()) await walk(full, left - 1);
      else if (accept(full)) await consider(full);
    }
  };
  await walk(dir, depth);
  if (best.size < 0) return "skip";
  return (await chunkHas(best.path, markers)) ? "ok" : "bad";
}

function recordKeysSeen(records: Json[]): Set<string> {
  const seen = new Set<string>();
  for (const d of records) {
    for (const key of AGENT_KEYS) if (key in d) seen.add(key);
    const labels = d.labels;
    const labelObj = labels && typeof labels === "object" && !Array.isArray(labels) ? (labels as Json) : null;
    if (labelObj && "role" in labelObj) seen.add("labels.role");
    if (labelObj?.["paseo.parent-agent-id"]) seen.add("labels.parent");
    const config = d.config;
    if (config && typeof config === "object" && (config as Json).model) seen.add("config.model");
    const persistence = d.persistence;
    if (persistence && typeof persistence === "object") {
      const p = persistence as Json;
      if (p.sessionId || p.nativeHandle) seen.add("persistence.session");
    }
  }
  return seen;
}

const DERIVED_KEY_PROBLEMS: Array<[string, MessageKey]> = [
  ["labels.role", "compat.audit.labelsRoleMissing"],
  ["labels.parent", "compat.audit.parentMissing"],
  ["config.model", "compat.audit.configModelMissing"],
  ["persistence.session", "compat.audit.sessionMissing"],
];

function profilesAbsent(cfg: Json | null): boolean {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
  const daemon = cfg.daemon;
  if (daemon !== undefined && (!daemon || typeof daemon !== "object" || Array.isArray(daemon))) return false;
  const profiles = daemon?.agentProfiles;
  return profiles === undefined || Array.isArray(profiles) && profiles.length === 0;
}

async function auditAgentRecords(paseoDir: string): Promise<string | null> {
  const dirs = await readdir(join(paseoDir, "agents")).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null);
  if (dirs?.length === 0) {
    const cfg = await readFile(join(paseoDir, "config.json"), "utf8").then(text => { try { return JSON.parse(text); } catch { return null; } }, () => null);
    if (profilesAbsent(cfg)) { console.log(t("compat.audit.emptyRecords")); return null; }
  }
  const records = await readAgentRecordFiles(paseoDir);
  if (records === null || records.length === 0) return t("compat.audit.recordsUnreadable");
  const seen = recordKeysSeen(records);
  for (const key of AGENT_KEYS) {
    if (!seen.has(key)) return t("compat.audit.recordKeyMissing", { key });
  }
  for (const [key, problem] of DERIVED_KEY_PROBLEMS) if (!seen.has(key)) return t(problem);
  return null;
}

async function auditDaemonLog(paseoDir: string): Promise<string | null> {
  const logPath = join(paseoDir, "daemon.log");
  const current = await readFile(logPath, "utf8").catch(() => null);
  if (current === null) return t("compat.audit.daemonLogUnreadable");
  const listed = await readFile(join(paseoDir, "daemon.log.txt"), "utf8").catch(() => "");
  const files = [logPath, ...listed.split("\n").map((s) => s.trim()).filter(Boolean)];
  let sawStartup = false;
  let parsedStartup = false;
  let sawVersion = parseDaemonVersion(current) !== null;
  for (const file of files) {
    const text = file === logPath ? current : await readFile(file, "utf8").catch(() => "");
    if (!sawVersion && parseDaemonVersion(text)) sawVersion = true;
    if (!text.includes("Starting daemon worker")) continue;
    sawStartup = true;
    if (parseDaemonRestartTimes(text).length > 0) parsedStartup = true;
  }
  if (sawStartup && !parsedStartup) return t("compat.audit.startupTimeUnparsed");
  if (!sawVersion) return t("compat.audit.noDaemonVersion");
  return null;
}

async function auditPaseoConfig(paseoDir: string): Promise<string | null> {
  const serverId = await readFile(join(paseoDir, "server-id"), "utf8").catch(() => "");
  if (!serverId.trim()) return t("compat.audit.serverIdUnreadable");
  let cfg: Json | null = null;
  try {
    cfg = JSON.parse(await readFile(join(paseoDir, "config.json"), "utf8"));
  } catch {
    return t("compat.audit.configUnreadable");
  }
  const profiles = cfg?.daemon?.agentProfiles;
  if (profilesAbsent(cfg)) { console.log(t("compat.audit.emptyProfiles")); return null; }
  if (!Array.isArray(profiles)) return t("compat.audit.noProfiles");
  const profile = profiles.find((p) => p && typeof p === "object" && (p as Json).role && (p as Json).provider && (p as Json).name);
  if (!profile) return t("compat.audit.profileFields");
  return null;
}

/** File-shaped dependencies under a Paseo home. Returns the first problem, or null. */
export async function auditPaseoFiles(paseoDir: string): Promise<string | null> {
  return (await auditAgentRecords(paseoDir)) ?? (await auditDaemonLog(paseoDir)) ?? (await auditPaseoConfig(paseoDir));
}

async function paseoJson(args: string[]): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const out = await runOutcome(BIN.paseo, args, 20_000);
  if (!out.ok) return { ok: false, error: out.error ?? t("compat.audit.commandFailed") };
  try {
    return { ok: true, value: JSON.parse(out.stdout) };
  } catch {
    return { ok: false, error: t("compat.audit.notJson") };
  }
}

async function helpMentionsJson(args: string[]): Promise<string | null> {
  const out = await runOutcome(BIN.paseo, args, 15_000);
  const text = `${out.stdout}\n${out.error ?? ""}`;
  if (!text.includes("--json")) return t("compat.audit.helpNoJson", { command: args.join(" ") });
  return null;
}

type PluginState = { status: string; error: string };

export async function auditPlugin(): Promise<string | null> {
  const jsonOut = await runOutcome(BIN.paseo, ["plugin", "ls", "--json"], 20_000);
  let plugin = null as PluginState | null;
  if (jsonOut.ok) {
    try {
      plugin = pluginFromJson(JSON.parse(jsonOut.stdout), "agent-fleet-cockpit");
    } catch (error) {
      console.error("[afc] compat: cannot parse plugin ls --json", String(error).slice(0, 120));
      plugin = null;
    }
  }
  const tableOut = await runOutcome(BIN.paseo, ["plugin", "ls", "--no-color"], 20_000);
  const fromTable = pluginRowFromTable(tableOut.stdout || "", "agent-fleet-cockpit");
  if (!plugin && fromTable) plugin = fromTable;
  if (!plugin) return t("compat.audit.pluginMissing");
  if (plugin.status !== "running") return t("compat.audit.pluginNotRunning", { status: plugin.status || t("compat.audit.statusEmpty") });
  if (plugin.error) return t("compat.audit.pluginError", { error: plugin.error.slice(0, 160) });
  if (fromTable?.error) return t("compat.audit.pluginError", { error: fromTable.error.slice(0, 160) });
  return null;
}

/** First array found at the value itself or under one of `keys`; null when there is none. */
function listFrom(value: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    const inner = (value as Json)[key];
    if (Array.isArray(inner)) return inner;
  }
  return null;
}

async function auditScheduleLogs(id: string): Promise<string | null> {
  const logs = await paseoJson(["schedule", "logs", id, "--json"]);
  if (!logs.ok) return t("compat.audit.cmdFailed", { command: "paseo schedule logs --json", error: logs.error.slice(0, 160) });
  const runs = listFrom(logs.value, ["runs", "items"]);
  if (!runs) return t("compat.audit.notList", { command: "paseo schedule logs --json" });
  const run = runs.find((r) => r && typeof r === "object") as Json | undefined;
  if (run && !("startedAt" in run) && !("started" in run)) return t("compat.audit.fieldMissing", { command: "paseo schedule logs --json", key: "startedAt" });
  if (run && !("status" in run)) return t("compat.audit.fieldMissing", { command: "paseo schedule logs --json", key: "status" });
  return null;
}

async function auditSchedules(): Promise<string | null> {
  const schedules = await paseoJson(["schedule", "ls", "--json"]);
  if (!schedules.ok) return t("compat.audit.cmdFailed", { command: "paseo schedule ls --json", error: schedules.error.slice(0, 160) });
  if (!Array.isArray(schedules.value)) return t("compat.audit.notList", { command: "paseo schedule ls --json" });
  const first = schedules.value.find((s) => s && typeof s === "object") as Json | undefined;
  if (!first) return null;
  for (const key of ["id", "target", "status"] as const) {
    if (!(key in first)) return t("compat.audit.fieldMissing", { command: "paseo schedule ls --json", key });
  }
  const id = String(first.id ?? "");
  return id ? auditScheduleLogs(id) : null;
}

async function auditPermitsAndCommands(): Promise<string | null> {
  const permits = await paseoJson(["permit", "ls", "--json"]);
  if (!permits.ok) return t("compat.audit.cmdFailed", { command: "paseo permit ls --json", error: permits.error.slice(0, 160) });
  if (!listFrom(permits.value, ["items", "requests"])) return t("compat.audit.notList", { command: "paseo permit ls --json" });
  for (const args of [
    ["archive", "--help"],
    ["agent", "open", "--help"],
    ["plugin", "reload", "--help"],
  ]) {
    const problem = await helpMentionsJson(args);
    if (problem) return problem;
  }
  const listed = await paseoJson(["ls", "-g", "--json"]);
  if (!listed.ok) return t("compat.audit.cmdFailed", { command: "paseo ls -g --json", error: listed.error.slice(0, 160) });
  if (!Array.isArray(listed.value)) return t("compat.audit.notList", { command: "paseo ls -g --json" });
  const agent = listed.value.find((a) => a && typeof a === "object") as Json | undefined;
  if (agent && (!agent.id || !agent.cwd || (agent.name == null && agent.title == null))) {
    return t("compat.audit.agentFields");
  }
  return null;
}

async function auditSdkTypes(pluginRoot: string): Promise<string | null> {
  const lifecycle = await readFile(join(pluginRoot, "node_modules/@getpaseo/plugin/dist/server/lifecycle.d.ts"), "utf8").catch(() => "");
  if (!lifecycle.includes('"agent.turn_ended"')) return t("compat.audit.turnEndedMissing");
  const types = await readFile(join(pluginRoot, "node_modules/@getpaseo/protocol/dist/agent-types.d.ts"), "utf8").catch(() => "");
  if (!types.includes('type: "tool_call"') || !types.includes('type: "assistant_message"') || !types.includes('type: "reasoning"')) {
    return t("compat.audit.timelineTypesMissing");
  }
  return null;
}

async function auditTranscripts(home: string): Promise<string | null> {
  const transcripts: Array<[string, string, number, (path: string) => boolean, string[]]> = [
    [t("compat.audit.claudeTranscripts"), join(home, ".claude", "projects"), 4, (p) => p.endsWith(".jsonl"), ['"usage"', '"assistant"']],
    [t("compat.audit.codexTranscripts"), join(home, ".codex", "sessions"), 4, (p) => /rollout-.*\.jsonl$/.test(p), ["token_count"]],
    ["Grok updates.jsonl", join(home, ".grok", "sessions"), 3, (p) => p.endsWith("/updates.jsonl"), ["stop_reason", '"usage"']],
    ["Grok chat_history.jsonl", join(home, ".grok", "sessions"), 3, (p) => p.endsWith("/chat_history.jsonl"), ['"type"', '"assistant"']],
  ];
  for (const [label, dir, depth, accept, markers] of transcripts) {
    const result = await sampleHas(dir, depth, accept, markers);
    if (result === "bad") return t("compat.audit.formatMismatch", { label });
  }
  return null;
}

/** Commands, event names, and on-disk transcripts. Returns the first problem, or null. */
export async function auditLive(pluginRoot: string, home = process.env.AFC_TRANSCRIPT_HOME || homedir()): Promise<string | null> {
  return (
    (await auditPlugin()) ??
    (await auditSchedules()) ??
    (await auditPermitsAndCommands()) ??
    (await auditSdkTypes(pluginRoot)) ??
    (await auditTranscripts(home))
  );
}
