/// <reference types="node" />
import { execFile } from "node:child_process";
import { commandInvocation } from "./command-invocation";
import { existsSync, readFileSync } from "./perf-fs";
import { z } from "zod";
import { onceLogger } from "./contract";
import { cockpitCli, cockpitStateFile, readContractSync } from "./afc-sources";
import { KanbanError } from "./errors";
import { addLocalDecision, doneLocalDecision, listLocalDecisions, LOCAL_DECISION_PREFIX, localDecisionsPath, type LocalDecision } from "./local-decisions";
import { openDecisionSchema, sortDecisions, type DecisionsSnapshot, type LeaderTarget, type OpenDecision } from "../shared/decisions";
import { cardDecisions } from "../shared/decisions";
import { cardMarkOf } from "./card-ref";
import { readAgentRecord } from "./open";
import { t } from "../shared/i18n";

/** The pending decision list exists but cannot be read or trusted. */
export function decisionsReadMessage(): string {
  return t("decisions.readFailed");
}
/** Neither the contract export nor the legacy list exists: the cockpit is not installed. Not an error. */
export const DECISIONS_NOT_INSTALLED_MESSAGE = "Decisions are not available (fleet cockpit not installed)";

type DecisionsRead = {
  items: OpenDecision[]; message: string | null;
  /** Set only when the file is there but its content could not be trusted (half-written, wrong shape, unreadable). */
  uncertain?: true;
  /** Set when the cockpit is not installed. The message is informational; the board shows nothing. */
  notInstalled?: true;
};

const logLocalProblem = onceLogger((message) => console.error("[paseo-kanban]", message));

/**
 * The cockpit is not installed: the board's own list stands in. Its rows are shown; a list that
 * cannot be trusted is uncertain, like a broken cockpit file.
 */
function notInstalled(): DecisionsRead {
  const local = readLocalOpen();
  if (local.uncertain) return { items: [], message: decisionsReadMessage(), uncertain: true };
  return { items: local.items, message: DECISIONS_NOT_INSTALLED_MESSAGE, notInstalled: true };
}

/** Open rows of the board's own list. A missing file is empty; a broken one is logged once and uncertain. */
function readLocalOpen(): { items: OpenDecision[]; uncertain: boolean } {
  const path = localDecisionsPath();
  try {
    const rows = listLocalDecisions({ path });
    return { items: sortDecisions(rows.map((row) => openDecisionSchema.parse({ ...row, owner: null }))), uncertain: false };
  } catch (err) {
    logLocalProblem(path, err instanceof Error ? err.message : String(err));
    return { items: [], uncertain: true };
  }
}

/** The cockpit's rows plus any open rows left in the board's own list (ids already listed by the cockpit win). */
function withLocal(read: DecisionsRead): DecisionsRead {
  const local = readLocalOpen();
  if (local.uncertain) return { ...read, message: read.message ?? decisionsReadMessage(), uncertain: true };
  if (local.items.length === 0) return read;
  const seen = new Set(read.items.map((item) => item.id));
  return { ...read, items: sortDecisions([...read.items, ...local.items.filter((item) => !seen.has(item.id))]) };
}

const logSkippedRow = onceLogger((message) => console.error("[paseo-kanban]", message));

/** Read only: never create, repair, or rewrite AFC's file. */
function readDecisionsFile(path: string): DecisionsRead {
  // No file at all means nobody has registered a decision.
  return readExistingDecisionsFile(path) ?? { items: [], message: decisionsReadMessage() };
}

/** Null when the file does not exist; otherwise its open rows, or `uncertain` when they cannot be trusted. */
function readExistingDecisionsFile(path: string): DecisionsRead | null {
  try {
    const rows = z.array(z.object({ status: z.string() }).passthrough()).parse(JSON.parse(readFileSync(path, "utf8")));
    const items = rows.filter((row) => row.status === "open").map((row) => openDecisionSchema.parse(row));
    return { items: sortDecisions(items), message: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { items: [], message: decisionsReadMessage(), uncertain: true };
  }
}

/**
 * The cockpit's open decisions. The path argument reads one legacy-format file (fixtures).
 * Otherwise the contract export `decisions-open.json` comes first; its rows gain the owner and
 * notes from the cockpit's full decisions.json when that file is found. A missing or invalid
 * export falls back to the full decisions.json alone. Neither file means the cockpit is not
 * installed: the board's own list (kanban-decisions.json) is read instead, and that is no read
 * error. Open rows still in the board's own list are always added, so nothing filed while the
 * cockpit was away disappears when it comes back.
 */
export function readOpenDecisions(path?: string): DecisionsRead {
  if (path !== undefined) return readDecisionsFile(path);
  const legacy = cockpitStateFile("decisions.json");
  const legacyRead = legacy ? readExistingDecisionsFile(legacy) : null;
  const contract = readContractSync("decisionsOpen");
  if (contract.state === "fresh" || contract.state === "stale") {
    return withLocal(contractDecisions(contract.path, contract.value.items, legacyRead?.items ?? []));
  }
  if (legacyRead) return withLocal(legacyRead);
  if (contract.state === "absent") return notInstalled();
  // The export is there but cannot be trusted (logged once by readContractSync), and there is
  // nothing to fall back to. Unlike dispatch, a decision read stays uncertain: an unknown answer
  // must not be taken for "nobody is waiting on the user".
  return { items: [], message: decisionsReadMessage(), uncertain: true };
}

/**
 * Contract rows checked one by one against the board's schema. A row the board cannot use
 * (for example an empty project) is skipped and logged once; the other rows still count.
 */
function contractDecisions(file: string, rows: readonly Record<string, unknown>[], legacy: readonly OpenDecision[]): DecisionsRead {
  const extra = new Map(legacy.map((item) => [item.id, item]));
  const items: OpenDecision[] = [];
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "(no id)";
    const parsed = openDecisionSchema.safeParse({
      ...row,
      status: "open",
      owner: extra.get(id)?.owner ?? null,
      userComments: extra.get(id)?.userComments,
    });
    if (parsed.success) items.push(parsed.data);
    else logSkippedRow(file, `decision ${id} skipped: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return { items: sortDecisions(items), message: null };
}

export function leaderTarget(agentId: string | null | undefined): LeaderTarget {
  const id = agentId?.trim();
  if (!id) return { agentId: null, reason: t("decisions.leader.none") };
  const record = readAgentRecord(id);
  if (record.state !== "ok") return { agentId: null, reason: t("decisions.leader.unreadable") };
  if (record.file.archivedAt) return { agentId: null, reason: t("decisions.leader.archived") };
  if (record.file.lastStatus === "closed") return { agentId: null, reason: t("decisions.leader.closed") };
  return { agentId: id, reason: null };
}

export function decisionBoardExtras(
  supervisors: Record<string, string>,
  project?: string,
  options: { path?: string; target?: (id: string | null | undefined) => LeaderTarget } = {},
): { decisions: DecisionsSnapshot; leaders: Record<string, LeaderTarget> } {
  const source = readOpenDecisions(options.path);
  const targets = new Map<string, LeaderTarget>();
  const inspect = options.target ?? leaderTarget;
  function target(id: string | null | undefined) {
    const key = id?.trim() || "";
    if (!targets.has(key)) targets.set(key, inspect(key));
    return targets.get(key)!;
  }
  const items = source.items.filter((item) => !project || item.project === project);
  const projects = project ? [project] : [...new Set([...Object.keys(supervisors), ...items.map((item) => item.project)])];
  const leaders = Object.fromEntries(projects.map((name) => [name, target(supervisors[name])]));
  return {
    leaders,
    decisions: {
      message: source.notInstalled ? null : source.message,
      items: items.map((item) => ({ ...item, leader: target(item.agentId || supervisors[item.project]) })),
    },
  };
}

/** Why a card is held back from the acceptance wake: an untrusted file, or the open decisions that name it. */
export interface DecisionBlock {
  uncertain: boolean;
  decisionIds: string[];
}

/**
 * Same exact-code matching as DEMO_0001. A source that cannot be trusted counts as waiting: an
 * unknown answer must not be taken for "nobody is waiting on the user". Null means nobody is.
 */
export function decisionBlock(
  task: { id: number; project: string; code_seq: number | null },
  source = readOpenDecisions(),
): DecisionBlock | null {
  if (source.uncertain) return { uncertain: true, decisionIds: [] };
  const matched = cardDecisions(cardMarkOf(task), source.items.map(item => ({
    ...item, leader: { agentId: null, reason: null },
  })));
  return matched.length > 0 ? { uncertain: false, decisionIds: matched.map((item) => item.id) } : null;
}

export function waitingOnDecision(
  task: { id: number; project: string; code_seq: number | null },
  source = readOpenDecisions(),
): boolean {
  return decisionBlock(task, source) != null;
}

// Filing and closing decisions. One interface for the board, missing-cwd and the command line:
// the cockpit's command line when the cockpit is installed, else the board's own list.

export type DecisionBackend = { kind: "cockpit"; cli: string } | { kind: "local"; path: string };

/** Command the cockpit used before it exported cockpit.json; only used when its old decisions.json is there. */
export const LEGACY_DECIDE_COMMAND = "roles";
const DECIDE_TIMEOUT_MS = 8_000;

/**
 * Where decisions go. The cockpit's exported command line first; an older cockpit that only has
 * its decisions.json uses its command on PATH; otherwise the board's own list.
 */
export function decisionBackend(): DecisionBackend {
  const cli = cockpitCli();
  if (cli) return { kind: "cockpit", cli };
  const legacy = cockpitStateFile("decisions.json");
  if (legacy && existsSync(legacy)) return { kind: "cockpit", cli: LEGACY_DECIDE_COMMAND };
  return { kind: "local", path: localDecisionsPath() };
}

export type DecideExec = (cmd: string, args: string[]) => Promise<string>;

function defaultExec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const invocation = commandInvocation(cmd, args);
    execFile(invocation.command, invocation.args, { timeout: DECIDE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolvePromise(String(stdout));
        return;
      }
      const reason = [err.message, String(stderr).trim(), String(stdout).trim()]
        .filter(Boolean).map((part) => part.slice(0, 400)).join("; ");
      reject(new Error(reason));
    });
  });
}

let decideExec: DecideExec = defaultExec;

/** Test hook: replace how the cockpit's command line is run. Null restores the default. */
export function setDecideExec(exec: DecideExec | null): void {
  decideExec = exec ?? defaultExec;
}

export interface DecisionAddInput {
  project: string;
  title: string;
  detail: string;
  blocking?: boolean;
  agentId?: string | null;
  source?: string | null;
}

export interface DecisionAddResult {
  backend: DecisionBackend["kind"];
  /** Null when the cockpit's output did not name the new id. */
  id: string | null;
  output: string;
}

/** The cockpit prints `added <id>`. */
function addedId(output: string): string | null {
  return /\badded\s+(\S+)/.exec(output)?.[1] ?? null;
}

/**
 * File one decision. The cockpit's command line does not take --json (it rejects unknown flags),
 * so its `added <id>` line is parsed instead.
 */
export async function addDecision(input: DecisionAddInput, backend: DecisionBackend = decisionBackend()): Promise<DecisionAddResult> {
  if (backend.kind === "local") {
    const row = addLocalDecision(input, { path: backend.path });
    return { backend: "local", id: row.id, output: `added ${row.id}` };
  }
  const args = ["decide", "add", "--project", input.project, "--title", input.title, "--detail", input.detail];
  if (input.blocking) args.push("--blocking");
  if (input.agentId?.trim()) args.push("--agent", input.agentId.trim());
  if (input.source?.trim()) args.push("--source", input.source.trim());
  const output = await decideExec(backend.cli, args);
  return { backend: "cockpit", id: addedId(output), output };
}

/**
 * Rows left open in the board's own list while the cockpit is installed (filed before it was).
 * A broken own list must not stop the cockpit's commands: it is logged once and read as empty.
 */
function localLeftovers(options: { all?: boolean } = {}): LocalDecision[] {
  const path = localDecisionsPath();
  try {
    return listLocalDecisions({ path, all: options.all });
  } catch (err) {
    logLocalProblem(path, err instanceof Error ? err.message : String(err));
    return [];
  }
}

export interface DecisionList {
  backend: DecisionBackend["kind"];
  /** The board's own rows in local mode; null when the cockpit printed the list. */
  items: LocalDecision[] | null;
  /** The cockpit's printed list, or the local rows as JSON. */
  output: string;
  /** With the cockpit installed: rows still in the board's own list. Close them with doneDecision as usual. */
  leftovers: LocalDecision[];
}

/** Open rows (or all rows) from the board's own list, or the cockpit's printed list plus local leftovers. */
export async function listDecisions(options: { all?: boolean } = {}, backend: DecisionBackend = decisionBackend()): Promise<DecisionList> {
  if (backend.kind === "local") {
    const items = listLocalDecisions({ path: backend.path, all: options.all });
    return { backend: "local", items, output: JSON.stringify(items, null, 2), leftovers: [] };
  }
  const output = await decideExec(backend.cli, ["decide", "ls", ...(options.all ? ["--all"] : [])]);
  return { backend: "cockpit", items: null, output, leftovers: localLeftovers(options) };
}

/** Which list `decide done` closes: the board's own list or the cockpit's. */
export type DecisionSource = "local" | "cockpit";

/** `--source local|cockpit` of `decide done`. Null when not given. */
export function parseDecisionSource(value: string | null | undefined): DecisionSource | null {
  const text = value?.trim() ?? "";
  if (!text) return null;
  if (text === "local" || text === "cockpit") return text;
  throw new KanbanError("invalid", `decide done --source must be local or cockpit, not ${text}`);
}

/**
 * Whether the cockpit lists the id, in its full decisions.json or its open-decisions export.
 * Missing files are "no"; null when a file is there but cannot be read, so the answer is unknown.
 */
function cockpitHasDecision(id: string): boolean | null {
  let unknown = false;
  const legacy = cockpitStateFile("decisions.json");
  if (legacy && existsSync(legacy)) {
    try {
      const rows: unknown = JSON.parse(readFileSync(legacy, "utf8"));
      if (!Array.isArray(rows)) unknown = true;
      else if (rows.some((item) => item && typeof item === "object" && (item as { id?: unknown }).id === id)) return true;
    } catch {
      unknown = true;
    }
  }
  const contract = readContractSync("decisionsOpen");
  if (contract.state === "fresh" || contract.state === "stale") {
    if (contract.value.items.some((row) => row.id === id)) return true;
  } else if (contract.state !== "absent") {
    unknown = true;
  }
  return unknown ? null : false;
}

/**
 * Which list an id without --source is closed in, in the same order the board shows and
 * findDecision looks up: only in the board's own list -> there; otherwise the cockpit. An id in
 * both lists (or in the own list while the cockpit's cannot be read) is never guessed.
 */
function doneSource(id: string): DecisionSource {
  if (!localLeftovers({ all: true }).some((row) => row.id === id)) return "cockpit";
  if (id.startsWith(LOCAL_DECISION_PREFIX)) return "local";
  const inCockpit = cockpitHasDecision(id);
  if (inCockpit === false) return "local";
  const why = inCockpit
    ? `Decision ${id} is in both the cockpit's list and the board's own list`
    : `Decision ${id} is in the board's own list, and the cockpit's list cannot be read to rule it out there`;
  throw new KanbanError("conflict", `${why}; say which one to close: decide done ${id} --source local (the board's own list) or --source cockpit`, { id });
}

/**
 * Close one decision. An id only in the board's own list is closed there whichever backend is
 * active, so rows filed before the cockpit was installed can still be closed afterwards. Other
 * ids go to the cockpit's command line when it is installed. `source` picks the list explicitly.
 */
export async function doneDecision(
  id: string,
  note: string | null,
  backend: DecisionBackend = decisionBackend(),
  options: { source?: DecisionSource | null } = {},
): Promise<{ backend: DecisionBackend["kind"]; output: string }> {
  if (backend.kind === "local") {
    if (options.source === "cockpit") throw new KanbanError("invalid", "decide done --source cockpit: the fleet cockpit is not installed");
    const row = doneLocalDecision(id, note, { path: backend.path });
    return { backend: "local", output: `done ${row.id}` };
  }
  const wanted = id.trim();
  if (!wanted) throw new KanbanError("invalid", "decide done needs a decision id");
  if ((options.source ?? doneSource(wanted)) === "local") {
    const row = doneLocalDecision(wanted, note);
    return { backend: "local", output: `done ${row.id} (board's own list)` };
  }
  const output = await decideExec(backend.cli, ["decide", "done", wanted, ...(note?.trim() ? ["--note", note.trim()] : [])]);
  return { backend: "cockpit", output };
}

export type DecisionLookup =
  | { found: true; status: string; source: "cockpit" | "local" }
  | { found: false; readable: boolean; where: string };

/**
 * Look one decision up in the cockpit's full decisions.json, then in the board's own list (the
 * order the board shows them in; doneDecision refuses to guess when an id is in both).
 * Throws when a list that exists cannot be read: an unknown status is not "not found".
 */
export function findDecision(id: string): DecisionLookup {
  const cockpit = cockpitStateFile("decisions.json");
  const places: string[] = [];
  let readable = false;
  if (cockpit && existsSync(cockpit)) {
    places.push(cockpit);
    const rows: unknown = JSON.parse(readFileSync(cockpit, "utf8"));
    readable = true;
    const row = Array.isArray(rows) ? rows.find((item) => item && typeof item === "object" && (item as { id?: unknown }).id === id) : undefined;
    if (row) return { found: true, status: String((row as { status?: unknown }).status), source: "cockpit" };
  }
  const localPath = localDecisionsPath();
  const local = listLocalDecisions({ path: localPath, all: true });
  if (existsSync(localPath)) {
    places.push(localPath);
    readable = true;
  }
  const row = local.find((item) => item.id === id);
  if (row) return { found: true, status: row.status, source: "local" };
  return { found: false, readable, where: places.join(", ") || "no decisions list found" };
}
