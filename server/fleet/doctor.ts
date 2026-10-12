/// <reference types="node" />
// One-click health check. Reads files and runs read-only commands (paseo ... ls/models/logs, `claude --version`,
// ps, kanban doctor --last); changes no file or setting, starts or stops nothing, logs in nowhere, and never opens
// credential, token or keychain files. Judgement is in shared/doctor-checks.ts.
import { existsSync, realpathSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { commandPath, platformCapabilities } from "./platform";
import { buildReport, type DoctorItem, type DoctorReport, makeItem } from "../../shared/fleet/doctor";
import {
  type ClaudeBinary,
  type ClaudeSession,
  checkClaudeCode,
  checkCompat,
  checkCoupons,
  checkDataDir,
  checkKanban,
  checkMigration,
  checkProfiles,
  checkQuota,
  checkResidue,
  checkSchedules,
  checkServices,
  countRefreshTimeouts,
  type DoctorProfile,
  inDispatchChain,
  type KanbanDoctorOutcome,
  type LegacyFileView,
  type MigrationView,
  parseClaudeSessions,
  parseProfiles,
  type ProviderState,
  type ScheduleRow,
  TIMEOUT_WINDOW_MIN,
} from "../../shared/fleet/doctor-checks";
import { t } from "../../shared/fleet/i18n";
import { decisionItems, MIGRATION_FILE, parseMigrationRecord } from "../../shared/fleet/migration";
import { kanbanSource } from "./kanban-source";
import { nvmBinDirs } from "./node-paths";
import { type DataDirChoice, dataDirChoice, kanbanDataDir, kanbanRoot } from "./paths";
import { BIN, CONFIG, HOME, PASEO_DIR, type RunOutcome, runOutcome, STATE_DIR, tilde } from "./util";

const LOG_TAIL_BYTES = 16 * 1024 * 1024;
const CMD_TIMEOUT_MS = 30_000;
const KANBAN_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 10_000;
const MAX_SCHEDULE_LOGS = 40;

export interface DoctorDeps {
  platform?: NodeJS.Platform;
  now: () => number;
  stateDir: string;
  paseoDir: string;
  configPath: string;
  /** Kanban's install directory (its `bin/kanban`). */
  kanbanRoot: string;
  /** Kanban's data directory; defaults to `<kanbanRoot>/data`. */
  kanbanDataDir?: string;
  /**
   * Kanban as its contract files describe it. Absent skips the board check; a `cli` replaces `<kanbanRoot>/bin/kanban`.
   * Omitted in tests that do not care, which keeps the install-directory lookup.
   */
  kanban?: () => { absent: boolean; cli: string | null };
  /** Which data directory the cockpit chose; omitted in tests that do not care. */
  dataDir?: DataDirChoice;
  paseoBin: string;
  run: (cmd: string, args: string[], timeoutMs: number) => Promise<RunOutcome>;
  readJson: (path: string) => Promise<unknown>;
  /** Last `maxBytes` of a text file, or null when it cannot be read. */
  readTail: (path: string, maxBytes: number) => Promise<string | null>;
  listLogs: (dir: string) => Promise<Array<{ name: string; mtimeMs: number }>>;
  pathDirs: () => Promise<string[]>;
  isFile: (path: string) => boolean;
  realpath: (path: string) => string;
  /** Text of a file, or null when it does not exist. Omitted in tests that do not look at MIGRATION.json. */
  readText?: (path: string) => Promise<string | null>;
  /** Size and modification time of a regular file, or null when there is none. */
  statFile?: (path: string) => Promise<{ size: number; mtimeMs: number } | null>;
}

export function productionDoctorDeps(): DoctorDeps {
  return {
    now: Date.now,
    stateDir: STATE_DIR,
    paseoDir: PASEO_DIR,
    configPath: CONFIG,
    kanbanRoot: kanbanRoot(),
    kanbanDataDir: kanbanDataDir(),
    kanban: () => {
      const source = kanbanSource();
      return { absent: source.presence === "absent", cli: source.info?.cli ?? null };
    },
    dataDir: dataDirChoice(),
    paseoBin: BIN.paseo,
    run: runOutcome,
    readJson: async (path) => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch {
        return null;
      }
    },
    readTail: async (path, maxBytes) => {
      try {
        const handle = await open(path, "r");
        try {
          const { size } = await handle.stat();
          const start = Math.max(0, size - maxBytes);
          const buffer = Buffer.alloc(size - start);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
          return buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          await handle.close();
        }
      } catch {
        return null;
      }
    },
    listLogs: async (dir) => {
      const names = (await readdir(dir)).filter((name) => name.endsWith("daemon.log"));
      const rows = await Promise.all(names.map(async (name) => ({ name, mtimeMs: (await stat(join(dir, name))).mtimeMs })));
      return rows;
    },
    pathDirs: async () => [...new Set([...commandPath().split(delimiter), ...(await nvmBinDirs()).slice(0, 1)])],
    isFile: (path) => existsSync(path),
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
    readText: readTextFile,
    statFile: statRegularFile,
  };
}

/** Text of a file, or null when it does not exist. */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Size and modification time of a regular file, or null when there is none. */
export async function statRegularFile(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function parseJsonList(out: RunOutcome): Array<Record<string, unknown>> | null {
  if (!out.ok) return null;
  try {
    const parsed: unknown = JSON.parse(out.stdout);
    return Array.isArray(parsed) ? parsed.map(record) : null;
  } catch {
    return null;
  }
}

async function paseoList(deps: DoctorDeps, args: string[]): Promise<Array<Record<string, unknown>> | null> {
  return parseJsonList(await deps.run(deps.paseoBin, args, CMD_TIMEOUT_MS));
}

async function disabledPools(deps: DoctorDeps): Promise<string[]> {
  const config = record(await deps.readJson(join(deps.kanbanDataDir ?? join(deps.kanbanRoot, "data"), "kanban.config.json")));
  return Array.isArray(config.disabledPools) ? config.disabledPools.filter((name): name is string => typeof name === "string") : [];
}

async function providerStates(deps: DoctorDeps): Promise<ProviderState[] | null> {
  const rows = await paseoList(deps, ["provider", "ls", "--json"]);
  if (!rows) return null;
  return rows.map((row) => ({
    provider: text(row.provider),
    label: text(row.label) || text(row.provider),
    status: text(row.status),
    enabled: text(row.enabled).toLowerCase() === "enabled",
  }));
}

async function modelLists(deps: DoctorDeps, providers: string[]): Promise<Record<string, string[] | null>> {
  const entries = await Promise.all(providers.map(async (provider) => {
    const out = await deps.run(deps.paseoBin, ["provider", "models", provider, "--json"], CMD_TIMEOUT_MS);
    const rows = parseJsonList(out);
    return [provider, rows ? rows.map((row) => text(row.id)).filter(Boolean) : null] as const;
  }));
  return Object.fromEntries(entries);
}

async function daemonTimeouts(deps: DoctorDeps, now: number): Promise<{ timeouts: Record<string, number>; problem: string | null }> {
  const since = now - TIMEOUT_WINDOW_MIN * 60_000;
  let logs: Array<{ name: string; mtimeMs: number }> = [];
  try {
    logs = await deps.listLogs(deps.paseoDir);
  } catch (error) {
    return { timeouts: {}, problem: t("doctor.server.listDirFailed", { dir: deps.paseoDir, error: String(error).slice(0, 100) }) };
  }
  if (!logs.some((row) => row.name === "daemon.log")) return { timeouts: {}, problem: t("doctor.server.daemonLogMissing", { dir: deps.paseoDir }) };
  // Count each log on its own and add the counts up. A rotated log can hold 160k+ lines; spreading them all into
  // one push() call blew the call stack (DEMO_0138).
  let timeouts: Record<string, number> = {};
  let problem: string | null = null;
  for (const log of logs.filter((row) => row.mtimeMs >= since || row.name === "daemon.log")) {
    const body = await deps.readTail(join(deps.paseoDir, log.name), LOG_TAIL_BYTES);
    if (body === null) {
      if (log.name === "daemon.log") problem = t("doctor.server.daemonLogUnreadable", { dir: deps.paseoDir });
      continue;
    }
    try {
      timeouts = addCounts(timeouts, countRefreshTimeouts(body.split("\n"), now));
    } catch (error) {
      problem = t("doctor.server.countFailed", { dir: deps.paseoDir, name: log.name, error: String(error).slice(0, 100) });
    }
  }
  return { timeouts, problem };
}

function addCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const sum = { ...a };
  for (const [name, count] of Object.entries(b)) sum[name] = (sum[name] ?? 0) + count;
  return sum;
}

async function claudeVersion(deps: DoctorDeps, path: string): Promise<string | null> {
  const out = await deps.run(path, ["--version"], VERSION_TIMEOUT_MS);
  return out.ok ? (/(\d+\.\d+\.\d+)/.exec(out.stdout)?.[1] ?? out.stdout.trim().slice(0, 40)) || null : null;
}

const VERSIONED_PATH = /\/(?:versions|claude-code)\/(\d+\.\d+\.\d+)(?:\/|$)/;

/** The version a running session was started from: read from its path when the path names one, else `--version` of that path. */
async function sessionsWithVersion(deps: DoctorDeps, rows: Array<{ pid: number; path: string }>, configReal: string | null, configVersion: string | null): Promise<ClaudeSession[]> {
  const byPath = new Map<string, string | null>();
  for (const path of new Set(rows.map((row) => row.path))) {
    const real = deps.realpath(path);
    byPath.set(path, real === configReal ? configVersion : VERSIONED_PATH.exec(real)?.[1] ?? (deps.isFile(path) ? await claudeVersion(deps, path) : null));
  }
  return rows.map((row) => ({ ...row, real: deps.realpath(row.path), version: byPath.get(row.path) ?? null }));
}

async function claudeItem(deps: DoctorDeps, config: unknown): Promise<DoctorItem> {
  if (!platformCapabilities(deps.platform).unixProcesses) return makeItem({ id: "claude-code", title: "Claude Code",
    summary: t("doctor.platform.processSkipped"), evidence: [], findings: [{ key: "process:skipped", status: "yellow", text: t("doctor.platform.processSkipped") }] });
  const command = record(record(record(record(config).agents).providers).claude).command;
  const configCommand = Array.isArray(command) && typeof command[0] === "string" ? command[0] : null;
  const configReal = configCommand ? deps.realpath(configCommand) : null;
  const configVersion = configCommand ? await claudeVersion(deps, configCommand) : null;
  const found = new Map<string, string>();
  for (const dir of await deps.pathDirs()) {
    const path = join(dir, "claude");
    if (deps.isFile(path)) found.set(deps.realpath(path), path);
  }
  const pathBinaries: ClaudeBinary[] = await Promise.all([...found].filter(([real]) => real !== configReal).map(async ([real, path]) => ({ path, real, version: await claudeVersion(deps, path) })));
  const ps = await deps.run("ps", ["-axo", "pid,command"], CMD_TIMEOUT_MS);
  const sessions = await sessionsWithVersion(deps, parseClaudeSessions(ps.stdout), configReal, configVersion);
  return checkClaudeCode({ configCommand, configReal, configVersion, pathBinaries, sessions });
}

async function scheduleRows(deps: DoctorDeps): Promise<ScheduleRow[] | null> {
  const list = await paseoList(deps, ["schedule", "ls", "--json"]);
  if (!list) return null;
  return Promise.all(list.slice(0, MAX_SCHEDULE_LOGS).map(async (row) => {
    const id = text(row.id);
    const base = { id, name: text(row.name) || id, status: text(row.status) };
    if (base.status !== "active") return { ...base, lastRun: null, logsError: null };
    const out = await deps.run(deps.paseoBin, ["schedule", "logs", id, "--json"], CMD_TIMEOUT_MS);
    const runs = parseJsonList(out);
    if (!runs) return { ...base, lastRun: null, logsError: (out.error ?? t("doctor.server.notJson")).slice(0, 100) };
    const last = [...runs].sort((a, b) => text(a.startedAt).localeCompare(text(b.startedAt))).at(-1);
    return { ...base, lastRun: last ? { status: text(last.status), startedAt: text(last.startedAt) || null, error: text(last.error) || null } : null, logsError: null };
  }));
}

/** The Kanban command the doctor runs: the one kanban.json names, else `<install dir>/bin/kanban`. */
function kanbanBin(deps: DoctorDeps): string {
  return deps.kanban?.().cli ?? join(deps.kanbanRoot, "bin", "kanban");
}

async function kanbanOutcome(deps: DoctorDeps): Promise<KanbanDoctorOutcome> {
  if (deps.kanban?.().absent) return { absent: true, ran: false, ok: false, timedOut: false, error: null, json: null };
  const bin = kanbanBin(deps);
  if (!deps.isFile(bin)) return { ran: false, ok: false, timedOut: false, error: null, json: null };
  const out = await deps.run(bin, ["doctor", "--last", "--json"], KANBAN_TIMEOUT_MS);
  let json: unknown = null;
  try {
    json = JSON.parse(out.stdout);
  } catch {
    json = null;
  }
  return { ran: true, ok: out.ok, timedOut: out.timedOut, error: out.error, json };
}

function viewOfDataDir(deps: DoctorDeps): { dir: string; source: DataDirChoice["source"]; dataDir: string } {
  const choice = deps.dataDir ?? { dir: deps.stateDir, source: "data-dir" as const, dataDir: deps.stateDir };
  return { dir: tilde(choice.dir), source: choice.source, dataDir: tilde(choice.dataDir) };
}

/** MIGRATION.json in the data directory, plus what the doctor compares it with. Reads and stats files only. */
async function migrationView(deps: DoctorDeps): Promise<MigrationView> {
  const dir = deps.dataDir?.dataDir ?? deps.stateDir;
  const path = join(dir, MIGRATION_FILE);
  const text = deps.readText ? await deps.readText(path) : null;
  if (text === null) return { state: "absent", path: tilde(path) };
  const parsed = parseMigrationRecord(text);
  if (!parsed.ok) return { state: "invalid", path: tilde(path), reason: parsed.reason };
  const { record } = parsed;
  const statFile = deps.statFile ?? (async () => null);
  const legacy: LegacyFileView[] = record.status !== "migrated" ? [] : await Promise.all(
    record.files.map(async (file) => ({ from: file.from, recorded: { size: file.size, mtimeMs: file.mtimeMs }, now: await statFile(join(record.from, ...file.from.split("/"))) })),
  );
  const decisionsNow = decisionItems(await deps.readJson(join(record.to, "decisions.json")))?.length ?? null;
  return { state: "ok", path: tilde(path), record, decisionsNow, legacy, usingLegacy: deps.dataDir?.source === "legacy" };
}

function crashed(id: string, title: string, error: unknown): DoctorItem {
  const message = String(error).slice(0, 160);
  return makeItem({ id, title, summary: t("doctor.server.crashSummary", { message: message.slice(0, 80) }), evidence: [], findings: [{ key: `${id}:crash`, status: "yellow", text: t("doctor.server.crashFinding", { message }) }] });
}

export async function runDoctor(deps: DoctorDeps = productionDoctorDeps()): Promise<DoctorReport> {
  const started = deps.now();
  const guard = async (id: string, title: string, work: () => Promise<DoctorItem>): Promise<DoctorItem> => {
    try {
      return await work();
    } catch (error) {
      return crashed(id, title, error);
    }
  };
  const config = await deps.readJson(deps.configPath);
  const stopped = await disabledPools(deps);
  const providers = await providerStates(deps);
  const profiles: DoctorProfile[] = parseProfiles(config);
  const items = await Promise.all([
    guard("platform", t("doctor.platform.title"), async () => {
      const platform = deps.platform ?? process.platform;
      const capabilities = platformCapabilities(platform);
      return makeItem({ id: "platform", title: t("doctor.platform.title"), summary: t("doctor.platform.summary", { platform, node: process.version }),
        evidence: [platform, process.version], findings: [
          { key: "platform:target", status: "yellow", text: t(capabilities.releaseTarget ? "doctor.platform.target" : "doctor.platform.unverified") },
          { key: "platform:keychain", status: "green", text: t(capabilities.keychain ? "doctor.platform.keychainOptional" : "doctor.platform.keychainSkipped") },
        ] });
    }),
    guard("quota", t("doctor.checks.quota.title"), async () => checkQuota(await deps.readJson(join(deps.stateDir, "pool-status.json")), stopped, deps.now(), tilde(join(deps.stateDir, "pool-status.json")))),
    guard("profiles", t("doctor.checks.profiles.title"), async () => {
      const wanted = [...new Set(profiles.filter(inDispatchChain).map((profile) => profile.provider).filter(Boolean))];
      return checkProfiles({ profiles, models: await modelLists(deps, wanted), providers, disabledPools: stopped });
    }),
    guard("services", t("doctor.checks.services.title"), async () => {
      const { timeouts, problem } = await daemonTimeouts(deps, deps.now());
      return checkServices({ providers: providers ?? [], timeouts, logProblem: problem });
    }),
    guard("claude-code", "Claude Code", () => claudeItem(deps, config)),
    guard("residue", t("doctor.checks.residue.title"), async () => {
      const [workspaces, projects] = await Promise.all([paseoList(deps, ["workspace", "ls", "--json"]), paseoList(deps, ["project", "ls", "--json"])]);
      if (!workspaces || !projects) return makeItem({ id: "residue", title: t("doctor.checks.residue.title"), summary: t("doctor.server.residueUnreadableSummary"), evidence: ["paseo workspace ls --json", "paseo project ls --json"], findings: [{ key: "residue:unreadable", status: "yellow", text: t("doctor.server.residueUnreadable") }] });
      return checkResidue({
        workspaces: workspaces.map((row) => ({ workspaceId: text(row.workspaceId), project: text(row.project), name: text(row.name), cwd: text(row.cwd) })),
        projects: projects.map((row) => ({ projectId: text(row.projectId), name: text(row.name), path: text(row.path) })),
      });
    }),
    guard("schedules", t("doctor.checks.schedules.title"), async () => {
      const rows = await scheduleRows(deps);
      if (!rows) return makeItem({ id: "schedules", title: t("doctor.checks.schedules.title"), summary: t("doctor.server.schedulesUnreadableSummary"), evidence: ["paseo schedule ls --json"], findings: [{ key: "schedules:unreadable", status: "yellow", text: t("doctor.server.schedulesUnreadable") }] });
      return checkSchedules(rows);
    }),
    guard("compat", t("doctor.checks.compat.title"), async () => checkCompat(await deps.readJson(join(deps.stateDir, "compat-state.json")), deps.now(), tilde(join(deps.stateDir, "compat-state.json")))),
    guard("coupons", t("doctor.checks.coupons.title"), async () => checkCoupons(await deps.readJson(join(deps.stateDir, "reset-coupons.json")), await deps.readJson(join(deps.stateDir, "plans.json")), deps.now(), [tilde(join(deps.stateDir, "reset-coupons.json")), tilde(join(deps.stateDir, "plans.json"))])),
    guard("data-dir", "Data directory", async () => checkDataDir(viewOfDataDir(deps))),
    guard("migration", "Migration check", async () => checkMigration(await migrationView(deps), deps.now())),
    guard("kanban", t("doctor.checks.kanban.title"), async () => checkKanban(await kanbanOutcome(deps), deps.now(), tilde(kanbanBin(deps)))),
  ]);
  return buildReport(items, new Date(started).toISOString(), deps.now() - started);
}
