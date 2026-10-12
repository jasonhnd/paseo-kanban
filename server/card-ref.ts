/// <reference types="node" />
import { formatCardCode, parseCardRef } from "../shared/card-code";
import { loadConfig } from "./config";
import { getDb } from "./db";
import { KanbanError } from "./errors";
import { t } from "../shared/i18n";
import { displayProjectCode, ensureProjectCode, projectsWithoutCode } from "./project-codes";

/** Next sequence number for a new card in this project. The caller inserts it immediately. */
export function takeCodeSeq(project: string): number {
  ensureProjectCode(project);
  const row = getDb().prepare("SELECT COALESCE(MAX(code_seq), 0) + 1 AS n FROM tasks WHERE project = ?").get(project) as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 1);
}

/**
 * Display number for a card already in hand. Falls back to `#id` when the sequence is missing or the
 * project has no code it can safely show. A missing or broken config file does not throw.
 */
export function cardMarkOf(task: { id: number; project: string; code_seq: number | null }, config?: Parameters<typeof displayProjectCode>[1]): string {
  if (task.code_seq == null) return `#${task.id}`;
  const code = displayProjectCode(task.project, config);
  return code ? formatCardCode(code, task.code_seq) : `#${task.id}`;
}

/** Display number for a global id. `#id` when that card is gone or has no sequence yet. */
export function cardMark(id: number): string {
  const row = getDb().prepare("SELECT id, project, code_seq FROM tasks WHERE id = ?").get(id) as
    | { id: number; project: string; code_seq: number | null }
    | undefined;
  if (!row) return `#${id}`;
  return cardMarkOf(row);
}

/**
 * Global id for a display code or an old id.
 * A bare number is the global id even when that card does not exist yet; the caller checks.
 * A display code must already point at a card.
 */
export function resolveTaskId(ref: unknown): number {
  if (typeof ref === "number" && Number.isInteger(ref) && ref > 0) return ref;
  if (typeof ref !== "string") throw new KanbanError("invalid", t("cardRef.error.missing"));
  const text = ref.trim();
  if (!text) throw new KanbanError("invalid", t("cardRef.error.missing"));
  const parsed = parseCardRef(text);
  if (!parsed) throw new KanbanError("invalid", t("cardRef.error.unrecognized", { text }));
  if (parsed.kind === "id") return parsed.id;
  const project = projectNameForCode(parsed.code);
  if (!project) throw new KanbanError("not_found", t("cardRef.error.noCode", { code: parsed.code }));
  const row = getDb().prepare("SELECT id FROM tasks WHERE project = ? AND code_seq = ?").get(project, parsed.seq) as
    | { id: number }
    | undefined;
  if (!row) throw new KanbanError("not_found", t("cardRef.error.noCard", { card: formatCardCode(parsed.code, parsed.seq) }));
  return row.id;
}

function projectsWithCards(): string[] {
  return (getDb().prepare("SELECT DISTINCT project FROM tasks").all() as unknown as Array<{ project: string }>).map((row) => row.project);
}

/**
 * Refuse a short code that a project without one already shows on its cards (DEMO_0001). Storing it for
 * another project would quietly move every number already written in comments, handoffs and commits there.
 */
export function assertCodeNotShown(project: string, code: string): void {
  const want = code.trim().toUpperCase();
  const name = project.trim();
  const shown = projectsWithoutCode(projectsWithCards(), loadConfig())
    .filter((row) => row.shown === want && row.project !== name)
    .map((row) => row.project);
  if (shown.length === 0) return;
  throw new KanbanError(
    "conflict",
    t("cardRef.error.codeShown", { code: want, projects: shown.join(t("common.listSep")), name }),
  );
}

/**
 * Project whose cards carry this code. A stored code wins. A project with cards but no stored code is
 * found by the derived code its cards are shown with (DEMO_0001: shown, never written back); two such
 * projects showing the same code are refused rather than guessed.
 */
export function projectNameForCode(code: string): string | null {
  const want = code.toUpperCase();
  const config = loadConfig();
  const hits = Object.entries(config.projects ?? {}).filter(([, row]) => row.code === want);
  if (hits.length === 1) return hits[0][0];
  if (hits.length > 1) throw new KanbanError("conflict", t("cardRef.error.codeAmbiguous", { code: want }));
  const shown = projectsWithoutCode(projectsWithCards(), config).filter((row) => row.shown === want);
  if (shown.length === 1) return shown[0].project;
  if (shown.length > 1) {
    throw new KanbanError("conflict", t("cardRef.error.codeAmbiguousDerived", { code: want, projects: shown.map((row) => row.project).join(t("common.listSep")) }));
  }
  return null;
}

/** Read-only lookup for the decisions panel: never throws, says why when the card is not there. */
export function lookupCard(code: string): { id: number | null; message: string | null } {
  try {
    return { id: resolveTaskId(code), message: null };
  } catch (err) {
    return { id: null, message: err instanceof KanbanError ? err.message : t("cardRef.error.lookupFailed", { code }) };
  }
}
