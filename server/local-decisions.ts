/// <reference types="node" />
// The board's own decisions list, used when the fleet cockpit is not installed.
// One JSON array in the board's data directory. Only add, ls and done: no comments, no reopening.
// Rows use the cockpit's decisions.json shape, so the board reads both the same way.
// Writes take an exclusive SQLite lock (released by the OS if the writer dies), write a temp file
// and rename it into place, so a reader never sees half a file.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { KanbanError } from "./errors";
import { dataDir } from "./paths";

export const LOCAL_DECISIONS_FILE = "kanban-decisions.json";
const LOCK_FILE = "kanban-decisions.lock.db";
const LOCK_WAIT_MS = 10_000;

export const localDecisionSchema = z.object({
  id: z.string().min(1),
  project: z.string().min(1),
  title: z.string(),
  detail: z.string(),
  blocking: z.boolean(),
  agentId: z.string().nullable(),
  source: z.string().nullable(),
  createdAt: z.string(),
  status: z.enum(["open", "done"]),
  doneAt: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});
export type LocalDecision = z.infer<typeof localDecisionSchema>;

export interface LocalDecisionInput {
  project: string;
  title: string;
  detail: string;
  blocking?: boolean;
  agentId?: string | null;
  source?: string | null;
}

export function localDecisionsPath(): string {
  return join(dataDir(), LOCAL_DECISIONS_FILE);
}

/** Rows in the file. Null when there is no file. Throws when the file is there but cannot be trusted. */
export function readLocalDecisionsFile(path: string = localDecisionsPath()): LocalDecision[] | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return z.array(localDecisionSchema).parse(JSON.parse(text));
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * Leading letter of new ids in the board's own list. The cockpit's ids start with "d", so a new
 * local id can never equal one of the cockpit's. Rows filed before this keep their "d" ids.
 */
export const LOCAL_DECISION_PREFIX = "k";

/** k<MMDD>-<HHMMSS>-<n>, local time, n counts up within the second. Same shape as the cockpit's d-ids. */
export function nextDecisionId(rows: readonly LocalDecision[], at: Date): string {
  const prefix = `${LOCAL_DECISION_PREFIX}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-`;
  const used = new Set(rows.map((row) => row.id));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

function writeAtomic(path: string, rows: readonly LocalDecision[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${LOCAL_DECISIONS_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

function withLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(join(dirname(path), LOCK_FILE));
  try {
    db.exec(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}`);
    db.exec("BEGIN IMMEDIATE");
  } catch (err) {
    db.close();
    const message = err instanceof Error ? err.message : String(err);
    if (/locked|busy/i.test(message)) throw new KanbanError("conflict", "The local decisions list is busy, try again");
    throw err;
  }
  try {
    return fn();
  } finally {
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }
}

/** Read, change and write the list under the lock. A file that cannot be trusted is never overwritten. */
function updateLocal<T>(path: string, mutate: (rows: LocalDecision[]) => { rows: LocalDecision[]; result: T }): T {
  return withLock(path, () => {
    let rows: LocalDecision[];
    try {
      rows = readLocalDecisionsFile(path) ?? [];
    } catch (err) {
      throw new KanbanError("invalid", `The local decisions list ${path} cannot be read; fix or move it first (${err instanceof Error ? err.message : String(err)})`);
    }
    const next = mutate(rows);
    writeAtomic(path, next.rows);
    return next.result;
  });
}

function requireText(value: string | undefined | null, name: string): string {
  const text = value?.trim() ?? "";
  if (!text) throw new KanbanError("invalid", `decide add needs --${name}`);
  return text;
}

export function addLocalDecision(input: LocalDecisionInput, options: { now?: Date; path?: string } = {}): LocalDecision {
  const project = requireText(input.project, "project");
  const title = requireText(input.title, "title");
  const at = options.now ?? new Date();
  return updateLocal(options.path ?? localDecisionsPath(), (rows) => {
    const row: LocalDecision = {
      id: nextDecisionId(rows, at),
      project,
      title,
      detail: input.detail?.trim() ?? "",
      blocking: input.blocking === true,
      agentId: input.agentId?.trim() || null,
      source: input.source?.trim() || null,
      createdAt: at.toISOString(),
      status: "open",
    };
    return { rows: [...rows, row], result: row };
  });
}

export function doneLocalDecision(id: string, note: string | null, options: { now?: Date; path?: string } = {}): LocalDecision {
  const wanted = id.trim();
  if (!wanted) throw new KanbanError("invalid", "decide done needs a decision id");
  const at = options.now ?? new Date();
  return updateLocal(options.path ?? localDecisionsPath(), (rows) => {
    const index = rows.findIndex((row) => row.id === wanted);
    if (index < 0) throw new KanbanError("not_found", `Decision ${wanted} is not in the local list`);
    const row: LocalDecision = { ...rows[index], status: "done", doneAt: at.toISOString(), note: note?.trim() || null };
    return { rows: rows.map((item, i) => (i === index ? row : item)), result: row };
  });
}

/** Open rows only unless `all`. A missing file is an empty list. Throws when the file cannot be trusted. */
export function listLocalDecisions(options: { all?: boolean; path?: string } = {}): LocalDecision[] {
  const rows = readLocalDecisionsFile(options.path ?? localDecisionsPath()) ?? [];
  return options.all ? rows : rows.filter((row) => row.status === "open");
}

export const DECIDE_HELP = `Usage: paseo-kanban decide <add|ls|done> [options] [--json]
  decide add --project P --title T --detail D [--blocking] [--agent ID] [--source S]
  decide ls [--all]
  decide done <id> [--note N] [--source local|cockpit]
With the fleet cockpit installed these go to its command line; without it, to the board's own list (${LOCAL_DECISIONS_FILE} in the board's data directory).
New ids in the board's own list start with "k" (the cockpit's start with "d"). done closes an id found in the board's own list there;
when the same id is in both lists, done stops and asks for --source local (the board's own list) or --source cockpit.`;

function formatRow(row: LocalDecision): string {
  const flags = [row.blocking ? "blocking" : null, row.status === "done" ? "done" : null].filter(Boolean).join(", ");
  return `${row.id}  [${row.project}] ${row.title}${flags ? ` (${flags})` : ""}`;
}

/** `paseo-kanban decide ...`. Returns the text to print. Throws KanbanError on bad input. */
export async function runDecideCli(argv: string[]): Promise<string> {
  const { parseKanbanArgs, wantsHelp } = await import("./argv");
  const { addDecision, doneDecision, listDecisions, parseDecisionSource } = await import("./decisions");
  if (argv.length === 0 || wantsHelp(argv)) return DECIDE_HELP;
  const parsed = parseKanbanArgs(argv);
  const print = (value: unknown, text: string) => (parsed.json ? JSON.stringify(value, null, 2) : text);
  if (parsed.cmd === "add") {
    const result = await addDecision({
      project: parsed.flag("project") ?? "",
      title: parsed.flag("title") ?? "",
      detail: parsed.flag("detail") ?? "",
      blocking: parsed.flag("blocking") === "true",
      agentId: parsed.flag("agent") ?? null,
      source: parsed.flag("source") ?? null,
    });
    return print({ ok: true, ...result }, result.output.trim());
  }
  if (parsed.cmd === "ls") {
    const result = await listDecisions({ all: parsed.flag("all") === "true" });
    if (!result.items) {
      const left = result.leftovers.length > 0 ? `\nStill in the board's own list:\n${result.leftovers.map(formatRow).join("\n")}` : "";
      return print({ ok: true, ...result }, `${result.output.trim()}${left}`);
    }
    const text = result.items.length > 0 ? result.items.map(formatRow).join("\n") : "No open decisions.";
    return print({ ok: true, backend: result.backend, items: result.items }, text);
  }
  if (parsed.cmd === "done") {
    const result = await doneDecision(parsed.positionals[0] ?? "", parsed.flag("note") ?? null, undefined, {
      source: parseDecisionSource(parsed.flag("source")),
    });
    return print({ ok: true, ...result }, result.output.trim());
  }
  throw new KanbanError("invalid", `Unknown decide command: ${parsed.cmd}\n${DECIDE_HELP}`);
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  runDecideCli(process.argv.slice(2)).then((text) => {
    if (text) console.log(text);
  }, (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (process.argv.includes("--json")) console.error(JSON.stringify(err instanceof KanbanError ? err.toJSON() : { ok: false, message }));
    else console.error(message);
    process.exit(1);
  });
}
