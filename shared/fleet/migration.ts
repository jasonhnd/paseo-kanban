// Moving the cockpit's state from a legacy directory into its data directory (`afc migrate`).
// This file is pure: the MIGRATION.json record, the file layout rule and small helpers shared by the
// command (server/migrate.ts) and the doctor's "Migration check" item (shared/doctor-checks.ts).
//
// Layout, source -> data directory:
//   <name>.json | .jsonl | .log (top level)   -> <name>            the cockpit's state files, same names
//   state/<name>                              -> secrets/<name>    private files (0700 dir, 0600 files)
//   backups/<any path>                        -> backups/legacy/<any path>
// Everything else in the source (docs, code, hidden files, symbolic links) stays where it is.
import { z } from "zod";

export const MIGRATION_FILE = "MIGRATION.json";
export const MIGRATION_SCHEMA = "afc-migration/v1";
export const ROLLBACK_SCHEMA = "afc-rollback/v1";
/** Days to keep the legacy directory untouched before `--finish`. */
export const OBSERVATION_DAYS = 7;

const DAY_MS = 86_400_000;

/** Migration ids are UTC timestamps to the second, e.g. 20300101T000000Z. */
export const MIGRATION_ID_PATTERN = /^\d{8}T\d{6}Z$/;

const DATA_FILE = /\.(json|jsonl|log)$/;
/** Top-level names that look like data but belong to a code checkout, plus our own record. */
const NOT_DATA = new Set(["package.json", "package-lock.json", "tsconfig.json", "jsconfig.json", MIGRATION_FILE]);
/** The files that make the cockpit treat a directory as holding its state (server/paths.ts STATE_MARKERS). */
export const MARKER_FILES = ["decisions.json", "plans.json"] as const;

export const SOURCE_SECRETS_DIR = "state";
export const TARGET_SECRETS_DIR = "secrets";
export const SOURCE_BACKUPS_DIR = "backups";
export const TARGET_BACKUPS_DIR = "backups/legacy";

export type FileKind = "data" | "secret" | "backup";

export function migrationId(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

export function isMigrationId(value: string): boolean {
  return MIGRATION_ID_PATTERN.test(value);
}

/** Whether a top-level file name in the source is cockpit state. */
export function isTopLevelDataFile(name: string): boolean {
  return !name.startsWith(".") && DATA_FILE.test(name) && !NOT_DATA.has(name);
}

/** Where a source path ("/"-separated, relative to the source) goes in the data directory, or null if it stays. */
export function targetFor(from: string): { to: string; kind: FileKind } | null {
  const parts = from.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) return null;
  if (parts.length === 1) return isTopLevelDataFile(parts[0]) ? { to: from, kind: "data" } : null;
  if (parts[0] === SOURCE_SECRETS_DIR) return parts.length === 2 ? { to: `${TARGET_SECRETS_DIR}/${parts[1]}`, kind: "secret" } : null;
  if (parts[0] === SOURCE_BACKUPS_DIR) return { to: `${TARGET_BACKUPS_DIR}/${parts.slice(1).join("/")}`, kind: "backup" };
  return null;
}

/** Whether a path relative to the data directory is one the layout fills (used to find files added after migration). */
export function isLayoutTarget(to: string): boolean {
  const parts = to.split("/");
  if (parts.some((part) => part === "" || part.startsWith("."))) return false;
  if (parts.length === 1) return isTopLevelDataFile(parts[0]);
  if (parts[0] === TARGET_SECRETS_DIR) return parts.length === 2;
  return to.startsWith(`${TARGET_BACKUPS_DIR}/`);
}

/** Copy order: backups first, marker files last, so an interrupted copy never makes the data directory look migrated. */
export function copyRank(entry: { to: string; kind: FileKind }): number {
  if ((MARKER_FILES as readonly string[]).includes(entry.to)) return 3;
  return entry.kind === "backup" ? 0 : entry.kind === "secret" ? 1 : 2;
}

// ---------------------------------------------------------------- MIGRATION.json

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoDateTime = z.iso.datetime({ offset: true });

export const MigrationFile = z
  .object({
    /** Path relative to the source directory, "/"-separated. */
    from: z.string(),
    /** Path relative to the data directory, "/"-separated. */
    to: z.string(),
    kind: z.enum(["data", "secret", "backup"]),
    size: z.number().int().nonnegative(),
    sha256,
    /** Source modification time when it was copied; the doctor compares it to spot later writes. */
    mtimeMs: z.number(),
  })
  // --finish deletes `from` and --rollback writes it, so only paths the layout produces are accepted.
  .refine((file) => {
    const target = targetFor(file.from);
    return target !== null && target.to === file.to && target.kind === file.kind;
  }, "file paths do not follow the migration layout");

export const MigrationRecord = z.object({
  schema: z.literal(MIGRATION_SCHEMA),
  id: z.string().regex(MIGRATION_ID_PATTERN),
  status: z.enum(["migrated", "rolled-back", "finished"]),
  /** Absolute source directory (symbolic links resolved). */
  from: z.string(),
  /** Absolute data directory. */
  to: z.string(),
  migratedAt: isoDateTime,
  /** Copy of the source taken at migration time, relative to the data directory. */
  backupDir: z.string().regex(/^backups\/migration-\d{8}T\d{6}Z$/),
  files: z.array(MigrationFile),
  checks: z.object({
    /** Items in decisions.json at migration time; null when there was none or it was unreadable. */
    decisions: z.number().int().nonnegative().nullable(),
    plansSha256: sha256.nullable(),
  }),
  plugin: z.string(),
  rolledBackAt: isoDateTime.nullable(),
  rollback: z
    .object({
      exportFile: z.string(),
      setAsideDir: z.string(),
      /** Legacy files that were missing and came back from the backup. */
      restored: z.array(z.string()),
      /** Legacy files that changed after migration; the newer legacy version was kept. */
      changedInLegacy: z.array(z.string()),
      /** The legacy link the rollback pointed back at the legacy directory (it pointed at the data directory). */
      linkRestored: z.object({ path: z.string(), from: z.string(), to: z.string() }).nullable().default(null),
    })
    .nullable(),
  finishedAt: isoDateTime.nullable(),
  finish: z
    .object({
      archive: z.string(),
      archiveSha256: sha256,
      removed: z.number().int().nonnegative(),
    })
    .nullable(),
});

export type MigrationFile = z.infer<typeof MigrationFile>;
export type MigrationRecord = z.infer<typeof MigrationRecord>;

/** Parse MIGRATION.json text; `reason` explains why it was rejected. */
export function parseMigrationRecord(text: string): { ok: true; record: MigrationRecord } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `bad JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = MigrationRecord.safeParse(json);
  if (parsed.success) return { ok: true, record: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, reason: `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}` };
}

/** Whole days since the migration, never negative. */
export function daysSince(iso: string, now: number): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / DAY_MS));
}

// ---------------------------------------------------------------- decisions.json

type Item = Record<string, unknown>;

const isItem = (value: unknown): value is Item => typeof value === "object" && value !== null && !Array.isArray(value);

/** decisions.json is a JSON array of items; null for anything else. */
export function decisionItems(json: unknown): Item[] | null {
  return Array.isArray(json) ? json.filter(isItem) : null;
}

export interface DecisionsDiff {
  added: Item[];
  changed: Array<{ before: Item; after: Item }>;
  removed: string[];
}

/** What changed in decisions.json since the migration snapshot, matched by `id`. */
export function diffDecisions(before: readonly Item[], after: readonly Item[]): DecisionsDiff {
  const key = (item: Item) => String(item.id ?? "");
  const old = new Map(before.map((item) => [key(item), item]));
  const now = new Set(after.map(key));
  const added: Item[] = [];
  const changed: Array<{ before: Item; after: Item }> = [];
  for (const item of after) {
    const previous = old.get(key(item));
    if (!previous) added.push(item);
    else if (JSON.stringify(previous) !== JSON.stringify(item)) changed.push({ before: previous, after: item });
  }
  const removed = before.map(key).filter((id) => !now.has(id));
  return { added, changed, removed };
}
