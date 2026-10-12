/// <reference types="node" />
import { BOARD_AGENT_ENV } from "./agent-env";
import { execFile } from "node:child_process";
import { commandInvocation, findCommand } from "./command-invocation";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createPaseoClient, type PaseoApi } from "@getpaseo/client";
import { t } from "../shared/i18n";
import { formatTickTime, tickAgeMs, TICK_WAKE_MS } from "../shared/scheduler";
import { readSchedulerTickAt } from "./liveness";
import { dataDirChoice, isPluginCheckout, isProductionDataDir, kanbanCliPath, projectRoot } from "./paths";
import { readAgentPage, readWorkspacePage } from "./paseo";
import { parseDispatchMatrix, realDispatchMatrixPath } from "./matrix";
import { profilesFromText, type Profile } from "./profiles";
import { paseoHome } from "./contract";

export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** Checks this run cannot make without side effects. A function: the texts follow the current language. */
function skippedChecks(): CheckResult[] {
  return [
    { name: t("compat.name.beforeCreate"), status: "skip", detail: t("compat.skip.noCreate") },
    { name: "before(agent.session_open)", status: "skip", detail: t("compat.skip.noSession") },
    { name: t("compat.name.turnEvents"), status: "skip", detail: t("compat.skip.noTurn") },
    { name: "PASEO_AGENT_ID", status: "skip", detail: t("compat.skip.agentId") },
    { name: BOARD_AGENT_ENV, status: "skip", detail: t("compat.skip.kanbanEnv") },
    { name: t("compat.name.worktreeCreate"), status: "skip", detail: t("compat.skip.worktree") },
    { name: t("compat.name.cliToken"), status: "skip", detail: t("compat.skip.cliToken") },
    { name: t("compat.name.mcpPort"), status: "skip", detail: t("compat.skip.mcpPort") },
    { name: t("compat.name.restartMarker"), status: "skip", detail: t("compat.skip.restartMarker") },
  ];
}

function text(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 240);
}

/** Missing file passes: the running plugin may not have been reloaded onto this build yet. */
export function checkSchedulerTick(at: string | null, now: number): CheckResult {
  const name = t("compat.name.schedulerTick");
  if (!at) return { name, status: "pass", detail: t("compat.tick.none") };
  const shown = formatTickTime(at);
  if (tickAgeMs(at, now) > TICK_WAKE_MS) return { name, status: "fail", detail: t("compat.tick.late", { shown }) };
  return { name, status: "pass", detail: t("compat.tick.last", { shown }) };
}

export function lineOf(result: CheckResult): string {
  if (result.status === "pass") return result.detail ? t("compat.line.passDetail", { name: result.name, detail: result.detail }) : t("compat.line.pass", { name: result.name });
  if (result.status === "skip") return t("compat.line.skip", { name: result.name, detail: result.detail });
  return t("compat.line.fail", { name: result.name, detail: result.detail || t("compat.line.unexplained") });
}

export function conclude(results: CheckResult[], version: string | null): { code: number; lines: string[] } {
  const lines = results.map(lineOf);
  const failed = results.find((item) => item.status === "fail");
  if (failed) {
    lines.push(t("compat.failed", { reason: failed.name }));
    return { code: 1, lines };
  }
  const shown = version?.trim() || t("compat.version.unknown");
  lines.push(t("compat.passed", { version: shown }));
  return { code: 0, lines };
}

export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = setTimeout(() => reject(new Error(t("compat.timeoutDetail", { label, elapsed: (performance.now() - started).toFixed(0), budget: ms }))), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function parsePluginTable(textBody: string, id = "paseo-kanban"): { ok: boolean; detail: string } {
  const lines = textBody.split("\n");
  if (!lines.some((line) => line.includes("PLUGIN") && line.includes("ERROR"))) return { ok: false, detail: t("compat.plugin.noErrorColumn") };
  const row = lines.find((line) => line.trim().startsWith(`${id} `) || line.trim() === id);
  if (!row) return { ok: false, detail: t("compat.plugin.missing", { id }) };
  const parts = row.trim().split(/\s{2,}/);
  const status = parts[1] ?? "";
  const error = (parts[6] ?? "").trim();
  if (status !== "running") return { ok: false, detail: t("compat.plugin.state", { status: status || t("compat.plugin.empty") }) };
  if (error) return { ok: false, detail: t("compat.plugin.error", { error }) };
  return { ok: true, detail: t("compat.plugin.running") };
}

export function parsePluginJson(textBody: string, id = "paseo-kanban"): { ok: boolean; detail: string } {
  let data: unknown;
  try {
    data = JSON.parse(textBody);
  } catch {
    return { ok: false, detail: t("compat.plugin.jsonNotJson") };
  }
  if (!Array.isArray(data)) return { ok: false, detail: t("compat.plugin.jsonNotArray") };
  const item = data.find((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === id) as
    | { status?: unknown; error?: unknown }
    | undefined;
  if (!item) return { ok: false, detail: t("compat.plugin.jsonMissing", { id }) };
  if (item.status !== "running") return { ok: false, detail: t("compat.plugin.jsonStatus", { status: String(item.status) }) };
  if (item.error != null && String(item.error).trim()) return { ok: false, detail: t("compat.plugin.jsonError", { error: String(item.error).trim() }) };
  return { ok: true, detail: "status=running" };
}

export function parseBoardJson(stdout: string): { ok: boolean; detail: string } {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, detail: t("compat.board.notJson") };
  }
  if (!data || typeof data !== "object") return { ok: false, detail: t("compat.board.notObject") };
  const board = data as { projects?: unknown; tasks?: unknown };
  if (!Array.isArray(board.projects) || !Array.isArray(board.tasks)) return { ok: false, detail: t("compat.board.missingFields") };
  return { ok: true, detail: t("compat.board.cards", { count: board.tasks.length }) };
}

export function checkProfileText(body: string): CheckResult[] {
  let profiles: Profile[];
  try {
    profiles = profilesFromText(body);
  } catch (err) {
    const detail = text(err);
    return [
      { name: t("compat.name.profiles"), status: "fail", detail },
      { name: "Cursor auto_accept", status: "fail", detail: t("compat.profiles.unreadable") },
    ];
  }
  const cursor = profiles.filter((profile) => profile.provider === "cursor");
  const auto: CheckResult =
    cursor.length === 0
      ? { name: "Cursor auto_accept", status: "skip", detail: t("compat.profiles.noCursor") }
      : cursor.every((profile) => typeof profile.featureValues?.auto_accept === "boolean")
        ? { name: "Cursor auto_accept", status: "pass", detail: t("compat.profiles.ok", { count: cursor.length }) }
        : { name: "Cursor auto_accept", status: "fail", detail: t("compat.profiles.notBoolean") };
  return [{ name: t("compat.name.profiles"), status: "pass", detail: t("compat.profiles.count", { count: profiles.length }) }, auto];
}

/** Format check for the dispatch matrix. A missing file is a pass: routing keeps the old rules. */
export function checkDispatchMatrixText(body: string): CheckResult {
  const name = t("compat.name.matrix");
  try {
    parseDispatchMatrix(JSON.parse(body) as unknown);
    return { name, status: "pass", detail: t("compat.matrix.ok") };
  } catch (err) {
    return { name, status: "fail", detail: text(err) };
  }
}

export function checkDispatchMatrixFile(path = realDispatchMatrixPath()): CheckResult {
  const name = t("compat.name.matrix");
  if (!path || !existsSync(path)) return { name, status: "pass", detail: t("compat.matrix.missing") };
  try {
    return checkDispatchMatrixText(readFileSync(path, "utf8"));
  } catch (err) {
    return { name, status: "fail", detail: text(err) };
  }
}

export function checkWorkspacesText(body: string): CheckResult {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { name: "workspaces.json", status: "fail", detail: t("compat.workspaces.notJson") };
  }
  if (!Array.isArray(data)) return { name: "workspaces.json", status: "fail", detail: t("compat.workspaces.notArray") };
  if (data.length === 0) return { name: "workspaces.json", status: "fail", detail: t("compat.workspaces.empty") };
  let worktrees = 0;
  for (const item of data) {
    if (!item || typeof item !== "object") return { name: "workspaces.json", status: "fail", detail: t("compat.workspaces.notObject") };
    const row = item as Record<string, unknown>;
    if (typeof row.workspaceId !== "string" || typeof row.cwd !== "string" || typeof row.kind !== "string") {
      return { name: "workspaces.json", status: "fail", detail: t("compat.workspaces.missingFields") };
    }
    if (!("archivedAt" in row) || (row.archivedAt != null && typeof row.archivedAt !== "string")) {
      return { name: "workspaces.json", status: "fail", detail: t("compat.workspaces.noArchivedAt") };
    }
    if (row.kind === "worktree") {
      worktrees += 1;
      if (row.mainRepoRoot != null && typeof row.mainRepoRoot !== "string") {
        return { name: "workspaces.json", status: "fail", detail: t("compat.workspaces.mainRepoRoot") };
      }
    }
  }
  return { name: "workspaces.json", status: "pass", detail: t("compat.workspaces.ok", { count: data.length, worktrees }) };
}

/** null = not an agent record. "ok" = the fields Kanban reads are present. Anything else is a broken field. */
function agentRecordOk(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.provider !== "string") return null;
  if ("archivedAt" in row && row.archivedAt != null && typeof row.archivedAt !== "string") return t("compat.agents.archivedAt", { id: row.id });
  if (!("archivedAt" in row) || !("workspaceId" in row)) return null;
  if (typeof row.cwd !== "string" || typeof row.title !== "string") return null;
  if (!row.labels || typeof row.labels !== "object" || Array.isArray(row.labels)) return null;
  if (!row.config || typeof row.config !== "object" || Array.isArray(row.config)) return null;
  return "ok";
}

export function checkAgentDir(root: string): CheckResult {
  if (!existsSync(root)) return { name: t("compat.name.agentRecords"), status: "fail", detail: t("compat.agents.noDir") };
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch (err) {
    return { name: t("compat.name.agentRecords"), status: "fail", detail: text(err) };
  }
  let seen = 0;
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(join(root, dir, name), "utf8"));
      } catch {
        return { name: t("compat.name.agentRecords"), status: "fail", detail: t("compat.agents.notJson", { name }) };
      }
      const verdict = agentRecordOk(data);
      if (verdict === null) continue;
      if (verdict !== "ok") return { name: t("compat.name.agentRecords"), status: "fail", detail: verdict };
      seen += 1;
    }
  }
  if (seen === 0) return { name: t("compat.name.agentRecords"), status: "fail", detail: t("compat.agents.none") };
  return { name: t("compat.name.agentRecords"), status: "pass", detail: t("compat.agents.ok", { count: seen }) };
}

export function checkServerId(path: string): CheckResult {
  try {
    const id = readFileSync(path, "utf8").trim();
    if (!id) return { name: "server-id", status: "fail", detail: t("compat.serverId.empty") };
    return { name: "server-id", status: "pass", detail: t("compat.serverId.ok") };
  } catch (err) {
    return { name: "server-id", status: "fail", detail: text(err) };
  }
}

export async function inspectDaemon(client: PaseoApi): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  try {
    const listed = await client.workspaces.list({ page: { limit: 20 } });
    const page = readWorkspacePage(listed);
    results.push(
      page.entries.length === 0
        ? { name: t("compat.name.workspaceList"), status: "fail", detail: t("compat.daemon.workspacesEmpty") }
        : { name: t("compat.name.workspaceList"), status: "pass", detail: t("compat.daemon.workspacesOk", { count: page.entries.length }) },
    );
  } catch (err) {
    results.push({ name: t("compat.name.workspaceList"), status: "fail", detail: text(err) });
  }
  try {
    const listed = await client.agents.list({ scope: "active", page: { limit: 20 } });
    const page = readAgentPage(listed);
    results.push(
      page.agents.length === 0
        ? { name: t("compat.name.agentList"), status: "fail", detail: t("compat.daemon.agentsEmpty") }
        : { name: t("compat.name.agentList"), status: "pass", detail: t("compat.daemon.agentsOk", { count: page.agents.length }) },
    );
  } catch (err) {
    results.push({ name: t("compat.name.agentList"), status: "fail", detail: text(err) });
  }
  const missing: string[] = [];
  if (typeof client.workspaces.create !== "function") missing.push("workspaces.create");
  if (typeof client.workspaces.archive !== "function") missing.push("workspaces.archive");
  if (typeof client.workspaces.ref !== "function") missing.push("workspaces.ref");
  if (typeof client.agents.create !== "function") missing.push("agents.create");
  if (typeof client.agents.ref !== "function") missing.push("agents.ref");
  else {
    const agentRef = client.agents.ref("compat-probe-not-a-real-agent");
    if (typeof agentRef.archive !== "function") missing.push("agents.ref.archive");
    if (typeof agentRef.send !== "function") missing.push("agents.ref.send");
    if (typeof agentRef.respondToPermission !== "function") missing.push("agents.ref.respondToPermission");
  }
  if (typeof client.workspaces.ref === "function") {
    const workspaceRef = client.workspaces.ref("compat-probe-not-a-real-workspace");
    if (typeof workspaceRef.agents?.create !== "function") missing.push("workspaces.ref.agents.create");
    if (typeof workspaceRef.archive !== "function") missing.push("workspaces.ref.archive");
  }
  results.push(
    missing.length === 0
      ? { name: t("compat.name.clientMethods"), status: "pass", detail: t("compat.daemon.methodsOk") }
      : { name: t("compat.name.clientMethods"), status: "fail", detail: t("compat.daemon.methodsMissing", { methods: missing.join(t("common.listSep")) }) },
  );
  results.push(
    typeof client.providers?.listModels === "function"
      ? { name: t("compat.name.modelEfforts"), status: "pass", detail: t("compat.daemon.listModelsOk") }
      : { name: t("compat.name.modelEfforts"), status: "fail", detail: t("compat.daemon.listModelsMissing") },
  );
  return results;
}

export interface CompatDeps {
  /** Explicit isolated validation without daemon or user configuration access. */
  offline?: boolean;
  databasePath?: string;
  cleanup?: () => void;
  typecheck(): Promise<{ ok: boolean; detail: string }>;
  offlineTest(): Promise<{ ok: boolean; detail: string }>;
  pluginTable(): Promise<string>;
  pluginJson(): Promise<string>;
  ping(): Promise<CommandOutput>;
  list(): Promise<CommandOutput>;
  version(): Promise<string>;
  openHelp(): Promise<string>;
  /** Present only for a live Paseo. Tests omit it. Never used to delete an agent. */
  deleteHelp?: () => Promise<string>;
  files(): CheckResult[];
  daemon(): Promise<CheckResult[]>;
  stepTimeoutMs?: number;
  checkTimeoutMs?: number;
  offlineTestTimeoutMs?: number;
  daemonTimeoutMs?: number;
}

function passed(ok: boolean, name: string, detail: string): CheckResult {
  return { name, status: ok ? "pass" : "fail", detail };
}

async function attempt(name: string, ms: number, run: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await withTimeout(run(), ms, t("compat.stepTimeout", { name }));
  } catch (err) {
    return { name, status: "fail", detail: text(err) };
  }
}

export async function runCompat(deps: CompatDeps): Promise<{ code: number; lines: string[] }> {
  if (deps.offline) return runOfflineCompat(deps);
  const stepMs = deps.stepTimeoutMs ?? 20_000;
  const longMs = deps.checkTimeoutMs ?? 180_000;
  const results: CheckResult[] = [];
  if (deps.databasePath) results.push({ name: t("compat.name.smokeDb"), status: "pass", detail: deps.databasePath });
  results.push(
    await attempt(t("compat.name.typecheck"), longMs, async () => {
      const outcome = await deps.typecheck();
      return passed(outcome.ok, t("compat.name.typecheck"), outcome.ok ? "tsc --noEmit" : outcome.detail || t("compat.run.failed"));
    }),
  );
  results.push(
    await attempt(t("compat.name.offlineTest"), deps.offlineTestTimeoutMs ?? deps.checkTimeoutMs ?? DEFAULT_OFFLINE_TEST_TIMEOUT_MS, async () => {
      const outcome = await deps.offlineTest();
      return passed(outcome.ok, t("compat.name.offlineTest"), outcome.ok ? ["npm test", outcome.detail].filter(Boolean).join(t("common.semicolon")) : outcome.detail || t("compat.run.failed"));
    }),
  );
  results.push(
    await attempt(t("compat.name.smokePluginLs"), stepMs, async () => {
      const [table, json] = await Promise.all([deps.pluginTable(), deps.pluginJson()]);
      const parsedTable = parsePluginTable(table);
      const parsedJson = parsePluginJson(json);
      if (!parsedTable.ok) return { name: t("compat.name.smokePluginLs"), status: "fail", detail: parsedTable.detail };
      if (!parsedJson.ok) return { name: t("compat.name.smokePluginLs"), status: "fail", detail: parsedJson.detail };
      return { name: t("compat.name.smokePluginLs"), status: "pass", detail: t("compat.plugin.running") };
    }),
  );
  results.push(
    await attempt(t("compat.name.smokePing"), stepMs, async () => {
      const output = await deps.ping();
      const ok = output.code === 0 && output.stdout.includes("kanban-pong");
      return passed(ok, t("compat.name.smokePing"), ok ? "kanban-pong" : output.stderr.trim() || output.stdout.trim() || t("compat.exitCode", { code: output.code }));
    }),
  );
  results.push(
    await attempt(t("compat.name.smokeList"), stepMs, async () => {
      const output = await deps.list();
      if (output.code !== 0) return { name: t("compat.name.smokeList"), status: "fail", detail: output.stderr.trim() || t("compat.exitCode", { code: output.code }) };
      const parsed = parseBoardJson(output.stdout);
      return passed(parsed.ok, t("compat.name.smokeList"), parsed.detail);
    }),
  );
  let version: string | null = null;
  results.push(
    await attempt("paseo --version", stepMs, async () => {
      const raw = (await deps.version()).trim();
      if (!raw) return { name: "paseo --version", status: "fail", detail: t("compat.run.noVersion") };
      version = raw.split("\n")[0]?.trim() || raw;
      return { name: "paseo --version", status: "pass", detail: version };
    }),
  );
  try {
    results.push(...deps.files());
  } catch (err) {
    results.push({ name: t("compat.name.localFiles"), status: "fail", detail: text(err) });
  }
  results.push(checkSchedulerTick(readSchedulerTickAt(), Date.now()));
  const daemonMs = deps.daemonTimeoutMs ?? 8_000;
  try {
    const checks = await withTimeout(deps.daemon(), daemonMs, t("compat.daemon.timeout", { ms: daemonMs }));
    if (checks.length === 0) results.push({ name: "daemon websocket", status: "fail", detail: t("compat.run.noChecks") });
    else results.push(...checks);
  } catch (err) {
    results.push({ name: "daemon websocket", status: "fail", detail: text(err) });
  }
  results.push(
    await attempt("paseo agent open --json", stepMs, async () => {
      const help = await deps.openHelp();
      if (!help.includes("--json")) return { name: "paseo agent open --json", status: "fail", detail: t("compat.run.openNoJson") };
      return { name: "paseo agent open --json", status: "pass", detail: t("compat.run.openOk") };
    }),
  );
  results.push(checkWorkspaceAgentCwd());
  results.push(checkWorktreeSlugSource());
  results.push(checkAgentCwdSource());
  if (deps.deleteHelp) {
    results.push(
      await attempt("paseo agent delete --help", stepMs, async () => {
        const help = await deps.deleteHelp!();
        if (!help.includes("--all") || !help.includes("--cwd")) {
          return { name: "paseo agent delete", status: "fail", detail: t("compat.run.deleteChanged") };
        }
        return { name: "paseo agent delete", status: "pass", detail: t("compat.run.deleteOk") };
      }),
    );
  }
  results.push(...skippedChecks());
  return conclude(results, version);
}

/** Used for permission changes that must be tested without connecting to the running board. */
async function runOfflineCompat(deps: CompatDeps): Promise<{ code: number; lines: string[] }> {
  const results: CheckResult[] = [];
  if (deps.databasePath) results.push({ name: t("compat.name.smokeDb"), status: "pass", detail: deps.databasePath });
  results.push(await attempt(t("compat.name.typecheck"), deps.checkTimeoutMs ?? 180_000, async () => {
    const output = await deps.typecheck();
    return passed(output.ok, t("compat.name.typecheck"), output.ok ? "tsc --noEmit" : output.detail);
  }));
  results.push(await attempt(t("compat.name.offlineTest"), deps.offlineTestTimeoutMs ?? DEFAULT_OFFLINE_TEST_TIMEOUT_MS, async () => {
    const output = await deps.offlineTest();
    return passed(output.ok, t("compat.name.offlineTest"), output.ok ? ["npm test", output.detail].filter(Boolean).join(t("common.semicolon")) : output.detail);
  }));
  results.push(await attempt(t("compat.name.smokePing"), deps.stepTimeoutMs ?? 20_000, async () => {
    const output = await deps.ping();
    const ok = output.code === 0 && output.stdout.includes("kanban-pong");
    return passed(ok, t("compat.name.smokePing"), ok ? "kanban-pong" : output.stderr || output.stdout || t("compat.exitCode", { code: output.code }));
  }));
  results.push(await attempt(t("compat.name.smokeList"), deps.stepTimeoutMs ?? 20_000, async () => {
    const output = await deps.list();
    if (output.code !== 0) return { name: t("compat.name.smokeList"), status: "fail", detail: output.stderr || t("compat.exitCode", { code: output.code }) };
    const parsed = parseBoardJson(output.stdout);
    return passed(parsed.ok, t("compat.name.smokeList"), parsed.detail);
  }));
  results.push(checkWorkspaceAgentCwd(), checkWorktreeSlugSource(), checkAgentCwdSource());
  for (const name of [t("compat.offline.cli"), t("compat.offline.files"), t("compat.offline.daemon")]) {
    results.push({ name, status: "skip", detail: t("compat.offline.skipped") });
  }
  const result = conclude(results, null);
  if (result.code === 0) result.lines[result.lines.length - 1] = t("compat.offline.passed");
  return result;
}

/**
 * A workspace-scoped create cannot name a different cwd. Kanban therefore cannot
 * hang a worktree card on the project's main workspace. This only reads the
 * installed client; it does not create an agent.
 */
export function checkWorkspaceAgentCwd(): CheckResult {
  const name = t("compat.name.workspaceCwd");
  const dts = join(projectRoot(), "node_modules/@getpaseo/client/dist/index.d.ts");
  const js = join(projectRoot(), "node_modules/@getpaseo/client/dist/index.js");
  if (!existsSync(dts) || !existsSync(js)) return { name, status: "skip", detail: t("compat.source.noClient") };
  const types = readFileSync(dts, "utf8");
  const code = readFileSync(js, "utf8");
  const omits = types.includes('PaseoWorkspaceAgentCreateOptions = Omit<PaseoAgentCreateOptions, "cwd">');
  const forces = code.includes("cwd: snapshot.workspaceDirectory");
  if (!omits || !forces) {
    return { name, status: "fail", detail: t("compat.source.cwdChanged") };
  }
  return { name, status: "pass", detail: t("compat.source.cwdOk") };
}

/**
 * A rebuilt card copy asks Paseo for a new directory name (DEMO_0001): Paseo's merge auto-archive remembers paths,
 * and a copy back on the old path is archived again. The worktree source must still accept worktreeSlug.
 */
export function checkWorktreeSlugSource(): CheckResult {
  const name = t("compat.name.worktreeSlug");
  const dts = join(projectRoot(), "node_modules/@getpaseo/protocol/dist/messages.d.ts");
  if (!existsSync(dts)) return { name, status: "skip", detail: t("compat.source.noProtocol") };
  const source = readFileSync(dts, "utf8");
  const start = source.indexOf("export declare const WorkspaceCreateRequestSchema");
  if (start < 0) return { name, status: "fail", detail: t("compat.source.noCreateSchema") };
  const next = source.indexOf("export declare const", start + "export declare const".length);
  const slice = source.slice(start, next < 0 ? undefined : next);
  const worktree = slice.indexOf('kind: z.ZodLiteral<"worktree">');
  if (worktree < 0 || !slice.slice(worktree).includes("worktreeSlug")) {
    return { name, status: "fail", detail: t("compat.source.slugMissing") };
  }
  return { name, status: "pass", detail: t("compat.source.slugOk") };
}

/** Read-only report of Paseo's "archive merged PR workspaces" switch (DEMO_0001). Either value is supported. */
export function checkAutoArchiveAfterMergeText(body: string): CheckResult {
  const name = t("compat.name.autoArchive");
  let value: unknown;
  try {
    value = (JSON.parse(body) as { daemon?: { autoArchiveAfterMerge?: unknown } } | null)?.daemon?.autoArchiveAfterMerge;
  } catch {
    return { name, status: "fail", detail: t("compat.autoArchive.notJson") };
  }
  if (value === true) {
    return { name, status: "pass", detail: t("compat.autoArchive.on") };
  }
  if (value === false || value === undefined) return { name, status: "pass", detail: t("compat.autoArchive.off") };
  return { name, status: "fail", detail: t("compat.autoArchive.notBoolean") };
}

/** List can include archived agents, but cannot filter by cwd. Kanban reads the record file. */
export function checkAgentCwdSource(): CheckResult {
  const name = t("compat.name.agentCwdFilter");
  const dts = join(projectRoot(), "node_modules/@getpaseo/protocol/dist/messages.d.ts");
  if (!existsSync(dts)) return { name, status: "skip", detail: t("compat.source.noProtocol") };
  const source = readFileSync(dts, "utf8");
  const start = source.indexOf("export declare const FetchAgentsRequestMessageSchema");
  if (start < 0) return { name, status: "fail", detail: t("compat.source.noFetchSchema") };
  const next = source.indexOf("export declare const", start + "export declare const".length);
  const slice = source.slice(start, next < 0 ? start + 4000 : next);
  if (!slice.includes("includeArchived")) return { name, status: "fail", detail: t("compat.source.noIncludeArchived") };
  if (/\bcwd\b/.test(slice)) return { name, status: "fail", detail: t("compat.source.hasCwd") };
  return { name, status: "pass", detail: t("compat.source.cwdFilterOk") };
}

export function runCompatCommand(cmd: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<CommandOutput> {
  const started = performance.now();
  return new Promise((resolve) => {
    const invocation = commandInvocation(cmd, args);
    execFile(invocation.command, invocation.args, { cwd: projectRoot(), timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout ?? "");
      const errText = String(stderr ?? "");
      if (!err) {
        resolve({ code: 0, stdout: out, stderr: errText });
        return;
      }
      const killed = Boolean((err as { killed?: boolean }).killed);
      const code = typeof err.code === "number" ? err.code : 1;
      resolve({ code: killed ? 124 : code, stdout: out, stderr: killed ? t("compat.commandTimeout", { elapsed: (performance.now() - started).toFixed(0), budget: timeoutMs }) : errText || err.message });
    });
  });
}

/** Child commands keep KANBAN_DATA_DIR so an isolated board is not replaced by the real one. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of [
    "KANBAN_TOKEN",
    "KANBAN_TASK",
    "KANBAN_ROLE",
    "KANBAN_PASEO_CONFIG",
    "KANBAN_AGENTS_DIR",
    "KANBAN_WORKSPACES_FILE",
    "KANBAN_PROJECT_ROOT",
    "KANBAN_POOL_STATUS",
    "KANBAN_DISPATCH_MATRIX",
    "KANBAN_PASEO_HOME",
    "PASEO_AGENT_ID",
    BOARD_AGENT_ENV,
  ]) {
    delete next[key];
  }
  return next;
}

/** A non-installation checkout defaults to an empty disposable board, never reads production. */
export function smokeDatabase(env: NodeJS.ProcessEnv, isolated = false): { env: NodeJS.ProcessEnv; path: string; cleanup: () => void } {
  const next = childEnv(env);
  let temporary: string | undefined;
  if (isolated || (!isPluginCheckout(env) && (!env.KANBAN_DATA_DIR || isProductionDataDir(env.KANBAN_DATA_DIR, env)))) {
    temporary = mkdtempSync(join(tmpdir(), "kanban-compat-"));
    next.KANBAN_DATA_DIR = temporary;
  }
  if (isolated) {
    // Even an installed checkout or explicitly supplied production path must remain untouched.
    // HOME stays intact for brief-file tests; every data/profile lookup gets its own fixture root.
    next.PASEO_HOME = temporary;
    // Fleet resolves beneath KANBAN_DATA_DIR/fleet; retired overrides are never fixture inputs.
    for (const key of ["AFC_DATA_DIR", "ROLES_STATE_DIR", "AFC_LEGACY_DATA_DIR"]) delete next[key];
    next.KANBAN_AGENTS_DIR = join(temporary!, "agents");
    // Missing/unreadable agent roots deliberately block dispatch. The fixture is empty, but readable.
    mkdirSync(next.KANBAN_AGENTS_DIR);
    next.KANBAN_PASEO_CONFIG = join(temporary!, "config.json");
  }
  const path = join(next.KANBAN_DATA_DIR?.trim() || dataDirChoice(next).dir, "kanban.db");
  return { env: next, path, cleanup: () => { if (temporary) rmSync(temporary, { recursive: true, force: true }); } };
}

export function localFileChecks(env: NodeJS.ProcessEnv = process.env): CheckResult[] {
  const home = paseoHome(env);
  const results: CheckResult[] = [];
  const configPath = join(home, "config.json");
  try {
    const body = readFileSync(configPath, "utf8");
    results.push(...checkProfileText(body));
    results.push(checkAutoArchiveAfterMergeText(body));
  } catch (err) {
    results.push({ name: t("compat.name.profiles"), status: "fail", detail: text(err) });
    results.push({ name: "Cursor auto_accept", status: "fail", detail: t("compat.profiles.unreadable") });
    results.push({ name: t("compat.name.autoArchive"), status: "skip", detail: t("compat.autoArchive.unreadable") });
  }
  const workspacesPath = join(home, "projects", "workspaces.json");
  try {
    results.push(checkWorkspacesText(readFileSync(workspacesPath, "utf8")));
  } catch (err) {
    results.push({ name: "workspaces.json", status: "fail", detail: text(err) });
  }
  results.push(checkAgentDir(join(home, "agents")));
  results.push(checkDispatchMatrixFile(realDispatchMatrixPath(env)));
  results.push(checkServerId(join(home, "server-id")));
  const commandHome = env.HOME ?? homedir();
  const bin = findCommand("paseo", env, commandHome);
  results.push(
    bin
      ? { name: t("compat.name.paseoBin"), status: "pass", detail: bin }
      : { name: t("compat.name.paseoBin"), status: "fail", detail: t("compat.binMissing", { bin: join(commandHome, ".local", "bin", "paseo") }) },
  );
  return results;
}

async function liveDaemon(url: string, timeoutMs: number): Promise<CheckResult[]> {
  const client = createPaseoClient({ url, reconnect: { enabled: false }, connectTimeoutMs: timeoutMs });
  try {
    await withTimeout(client.connect(), timeoutMs, t("compat.daemon.connectFailed", { url }));
    const checks = await withTimeout(inspectDaemon(client), timeoutMs, t("compat.daemon.listTimeout"));
    return [{ name: "daemon websocket", status: "pass", detail: url }, ...checks];
  } catch (err) {
    return [
      { name: "daemon websocket", status: "fail", detail: t("compat.daemon.connectFailedDetail", { url, error: text(err) }) },
      { name: t("compat.name.workspaceList"), status: "skip", detail: t("compat.daemon.notConnected") },
      { name: t("compat.name.agentList"), status: "skip", detail: t("compat.daemon.notConnected") },
      { name: t("compat.name.clientMethods"), status: "skip", detail: t("compat.daemon.notConnected") },
    ];
  } finally {
    await client.close().catch(() => undefined);
  }
}

// Current full suite takes about 300s under concurrent agent load; allow 2x.
export const DEFAULT_OFFLINE_TEST_TIMEOUT_MS = 600_000;
const COMPAT_OVERHEAD_MS = 300_000;

export function offlineTestTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.KANBAN_COMPAT_OFFLINE_TEST_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_OFFLINE_TEST_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647 - COMPAT_OVERHEAD_MS) {
    throw new Error(t("compat.env.offlineTimeout"));
  }
  return value;
}

export function realDeps(env: NodeJS.ProcessEnv = process.env): CompatDeps {
  const mode = env.KANBAN_COMPAT_OFFLINE?.trim();
  if (mode && mode !== "0" && mode !== "1") throw new Error(t("compat.offline.invalid"));
  const offlineMs = offlineTestTimeoutMs(env);
  const smoke = smokeDatabase(env, mode === "1");
  const envForChild = smoke.env;
  const url = env.PASEO_URL?.trim() || "ws://127.0.0.1:6767/ws";
  const connectMs = 8_000;
  const bin = kanbanCliPath(projectRoot());
  return {
    offline: mode === "1",
    databasePath: smoke.path,
    cleanup: smoke.cleanup,
    checkTimeoutMs: 360_000,
    offlineTestTimeoutMs: offlineMs,
    stepTimeoutMs: 20_000,
    daemonTimeoutMs: connectMs * 2 + 1_000,
    typecheck: async () => {
      const output = await runCompatCommand("npm", ["run", "typecheck"], 120_000, envForChild);
      const detail = (output.stderr || output.stdout).trim().slice(0, 240);
      return { ok: output.code === 0, detail };
    },
    offlineTest: async () => {
      const output = await runCompatCommand("npm", ["test"], offlineMs, envForChild);
      // Preserve the timing-gate decision, including load-based skips, in compat's report.
      const detail = output.code === 0
        ? output.stdout.split("\n").filter(line => line.includes("PERFORMANCE LOAD")).join(" ").trim()
        : (output.stderr || output.stdout).trim().slice(0, 240);
      return { ok: output.code === 0, detail };
    },
    pluginTable: async () => {
      const output = await runCompatCommand("paseo", ["plugin", "ls"], 20_000, envForChild);
      if (output.code !== 0) throw new Error(output.stderr.trim() || t("compat.run.pluginLsFailed"));
      return output.stdout;
    },
    pluginJson: async () => {
      const output = await runCompatCommand("paseo", ["plugin", "ls", "--json"], 20_000, envForChild);
      if (output.code !== 0) throw new Error(output.stderr.trim() || t("compat.run.pluginLsJsonFailed"));
      return output.stdout;
    },
    ping: () => runCompatCommand(bin, ["ping"], 20_000, envForChild),
    list: () => runCompatCommand(bin, ["list", "--json"], 20_000, envForChild),
    version: async () => {
      const output = await runCompatCommand("paseo", ["--version"], 20_000, envForChild);
      if (output.code !== 0) throw new Error(output.stderr.trim() || t("compat.exitCode", { code: output.code }));
      return output.stdout;
    },
    openHelp: async () => {
      const output = await runCompatCommand("paseo", ["agent", "open", "--help"], 20_000, envForChild);
      return `${output.stdout}\n${output.stderr}`;
    },
    deleteHelp: async () => {
      const output = await runCompatCommand("paseo", ["agent", "delete", "--help"], 20_000, envForChild);
      return `${output.stdout}\n${output.stderr}`;
    },
    files: () => localFileChecks(env),
    daemon: () => liveDaemon(url, connectMs),
  };
}

/** Run every check. Times out the whole run so a stuck daemon cannot hang the process. */
export async function runCompatChecked(env: NodeJS.ProcessEnv = process.env, deps?: CompatDeps): Promise<{ code: number; lines: string[] }> {
  const used = deps ?? realDeps(env);
  const overall = Number(env.KANBAN_COMPAT_TIMEOUT_MS) || (used.offlineTestTimeoutMs ?? used.checkTimeoutMs ?? DEFAULT_OFFLINE_TEST_TIMEOUT_MS) + COMPAT_OVERHEAD_MS;
  try {
    return await withTimeout(runCompat(used), overall, t("compat.run.overallTimeout"));
  } catch (err) {
    return { code: 1, lines: [t("compat.failed", { reason: text(err) })] };
  } finally {
    used.cleanup?.();
  }
}
