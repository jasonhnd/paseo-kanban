/// <reference types="node" />
import { readPolicy } from "./application/policy-snapshot";
import { actualModel } from "../shared/fleet/review-model";
import { t } from "../shared/i18n";
import { readFileSync, statSync } from "./perf-fs";
import { cockpitStateFile, contractPath, readContractSync } from "./afc-sources";
import { classifyFreshness, CONTRACT_SCHEMA, envelopeAgeSeconds } from "./contract";
import { isEffort, type Effort } from "./effort";
import { isTier, type Tier } from "./tier";

/** Shown at the top of the board when the file exists but cannot be used. */
export function matrixFailMessage(): string {
  return t("matrix.failMessage");
}

const STAR_ROLES = ["reader", "decision", "batch"] as const;
const OPS_ROLES = ["ops_vercel", "ops_cloudflare", "ops_github", "ops_notion"] as const;
const WILDCARD_ROLES = [...STAR_ROLES, ...OPS_ROLES] as const;
export type StarRole = (typeof STAR_ROLES)[number];
export type OpsRole = (typeof OPS_ROLES)[number];
export type WildcardRole = (typeof WILDCARD_ROLES)[number];
const KNOWN_ROLES = new Set<string>(["executor", "reviewer", ...WILDCARD_ROLES]);

/** Reader, decision, batch, and the four ops roles all read `roles.<role>["*"]`. */
export function isWildcardRole(role: string): role is WildcardRole {
  return (WILDCARD_ROLES as readonly string[]).includes(role);
}

/** The four ops roles. Reader, decision and batch are not ops roles. */
export function isOpsRole(role: string): role is OpsRole {
  return (OPS_ROLES as readonly string[]).includes(role);
}

export interface MatrixItem {
  profile: string;
  /** Explicit candidate order takes precedence over quota preferences, never eligibility checks. */
  order?: number;
  /** Null means keep the profile's own thinkingOptionId. */
  effort: Effort | null;
  /**
   * AFC marks a candidate paused. Kanban skips it and does not look outside the list.
   * Ignored while the pool snapshot or the matrix itself is stale; the stale stop lines still apply.
   */
  paused: boolean;
}

/** User-set pool order (AFC plans.json dispatchPriority). Lists are already sorted by it. */
export interface MatrixPriority {
  order: string[];
  until: string;
  untilMs: number;
}

export interface DispatchMatrix {
  version: number;
  generatedAt: string | null;
  defaultTier: Tier;
  downgradeWhenTight: Tier[];
  /** Missing tier means an empty list: queue, do not look outside the matrix. */
  executor: Partial<Record<Tier, MatrixItem[]>>;
  /** Insertion order is the order standalone reviews walk. */
  reviewerModels?: Record<string, Partial<Record<Tier, MatrixItem[]>>>;
  reviewerFamilies: Record<string, Partial<Record<Tier, MatrixItem[]>>>;
  /** `*` lists for reader, decision, batch, and the four ops roles. Not executor tiers. */
  star: Partial<Record<WildcardRole, MatrixItem[]>>;
  /** Explicit difficulty lists take precedence over the role's wildcard list, including empty lists. */
  starTiers?: Partial<Record<StarRole, Partial<Record<Tier, MatrixItem[]>>>>;
  /** Missing or malformed means no priority. */
  priority?: MatrixPriority | null;
  /**
   * True when the file is a contract export older than ttlSeconds * 3. Its order still counts;
   * its paused marks are ignored. Legacy files carry no envelope and are never stale here.
   */
  stale?: boolean;
  /** Age of a contract export, from generatedAt. Null for a legacy file. */
  ageMs?: number | null;
}

export type MatrixLoad =
  | { state: "missing" }
  | { state: "invalid"; message: string; detail: string; ageMs: number | null; updatedAt: string | null; path: string }
  | { state: "ok"; matrix: DispatchMatrix; path: string };

/**
 * The matrix file the cockpit really writes: its contract export when that parses, else its
 * legacy dispatch-matrix.json when one is found. Null when neither exists. Compat checks this
 * path, not a test override.
 */
export function realDispatchMatrixPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const contract = readContractSync("dispatchMatrix", { path: contractPath("dispatchMatrix", env) });
  if (contract.state === "fresh" || contract.state === "stale") return contract.path;
  return cockpitStateFile("dispatch-matrix.json", env);
}

/**
 * Path the scheduler reads.
 * `KANBAN_DISPATCH_MATRIX` overrides it (tests point this at a temp file).
 * Inside the test runner, an unset override means "no file" so a suite never
 * reads the real matrix and changes old routing by accident.
 */
export function matrixPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.KANBAN_DISPATCH_MATRIX?.trim();
  if (override) return override;
  if (env.NODE_TEST_CONTEXT) return null;
  return realDispatchMatrixPath(env);
}

function fail(message: string): never {
  throw new Error(message);
}

function parseItem(value: unknown, where: string): MatrixItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(t("matrix.notObject", { where }));
  const raw = value as Record<string, unknown>;
  if (typeof raw.profile !== "string" || !raw.profile.trim()) fail(t("matrix.missingProfile", { where }));
  let effort: Effort | null = null;
  if (raw.effort != null) {
    if (typeof raw.effort !== "string" || !isEffort(raw.effort)) fail(t("matrix.badEffort", { where }));
    effort = raw.effort;
  }
  if (raw.order !== undefined && (typeof raw.order !== "number" || !Number.isInteger(raw.order) || raw.order < 1 || raw.order > 1000)) {
    fail(t("matrix.badOrder", { where }));
  }
  return {
    profile: raw.profile.trim(), effort, paused: raw.paused === true,
    ...(raw.order !== undefined ? { order: raw.order as number } : {}),
  };
}

function parseTierMap(value: unknown, where: string): Partial<Record<Tier, MatrixItem[]>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(t("matrix.notObject", { where }));
  const map: Partial<Record<Tier, MatrixItem[]>> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!isTier(key)) continue;
    if (!Array.isArray(item)) fail(t("matrix.notArray", { where: `${where}.${key}` }));
    map[key] = item.map((entry, index) => parseItem(entry, `${where}.${key}[${index}]`));
  }
  return map;
}

/** Top-level priority. A bad shape is treated as absent, never as an error. */
export function parseMatrixPriority(value: unknown): MatrixPriority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.order) || !raw.order.every((pool) => typeof pool === "string" && pool.trim())) return null;
  if (typeof raw.until !== "string") return null;
  const untilMs = Date.parse(raw.until);
  if (!Number.isFinite(untilMs)) return null;
  return { order: (raw.order as string[]).map((pool) => pool.trim()), until: raw.until, untilMs };
}

/** True while the user's pool order is in force. */
export function priorityActive(matrix: DispatchMatrix | null | undefined, now: number): boolean {
  const priority = matrix?.priority;
  return !!priority && now < priority.untilMs;
}

/**
 * Parse a matrix object. Unknown role keys are ignored.
 * Reader, decision, batch and the four ops roles read `*`. A missing or empty `*` is an empty list.
 * A malformed known role object, list or item throws a readable reason.
 */
export function parseDispatchMatrix(value: unknown): DispatchMatrix {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(t("matrix.rootNotObject"));
  const raw = value as Record<string, unknown>;
  if (typeof raw.version !== "number" || !Number.isFinite(raw.version)) fail(t("matrix.missingVersion"));
  if (typeof raw.defaultTier !== "string" || !isTier(raw.defaultTier)) fail(t("matrix.badDefaultTier"));
  if (!raw.roles || typeof raw.roles !== "object" || Array.isArray(raw.roles)) fail(t("matrix.missingRoles"));
  if (!Array.isArray(raw.downgradeWhenTight)) fail(t("matrix.missingDowngrade"));
  const downgradeWhenTight: Tier[] = [];
  for (const item of raw.downgradeWhenTight) {
    if (typeof item !== "string" || !isTier(item)) fail(t("matrix.badDowngradeItem"));
    downgradeWhenTight.push(item);
  }
  const roles = raw.roles as Record<string, unknown>;
  let executor: Partial<Record<Tier, MatrixItem[]>> = {};
  let reviewerFamilies: Record<string, Partial<Record<Tier, MatrixItem[]>>> = {};
  let reviewerModels: DispatchMatrix["reviewerModels"];
  const star: Partial<Record<WildcardRole, MatrixItem[]>> = {};
  const starTiers: NonNullable<DispatchMatrix["starTiers"]> = {};
  for (const [key, body] of Object.entries(roles)) {
    if (!KNOWN_ROLES.has(key)) continue;
    if (key === "executor") {
      executor = parseTierMap(body, "executor");
      continue;
    }
    if (key === "reviewer") {
      if (!body || typeof body !== "object" || Array.isArray(body)) fail(t("matrix.notObject", { where: "reviewer" }));
      const reviewer = body as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(reviewer, "byExecutorModel")) {
        const models = reviewer.byExecutorModel;
        if (!models || typeof models !== "object" || Array.isArray(models)) fail("Invalid reviewer model branches");
        reviewerModels = {};
        for (const [model, tiers] of Object.entries(models)) {
          const key = actualModel(model);
          if (!key || key !== model || key in reviewerModels) fail("Invalid exact reviewer model key");
          reviewerModels[key] = parseTierMap(tiers, `reviewer.${key}`);
        }
      }
      const families = reviewer.byExecutorFamily;
      if (families == null) continue;
      if (typeof families !== "object" || Array.isArray(families)) fail(t("matrix.notObject", { where: "reviewer.byExecutorFamily" }));
      reviewerFamilies = {};
      for (const [family, tiers] of Object.entries(families as Record<string, unknown>)) {
        reviewerFamilies[family] = parseTierMap(tiers, `reviewer.${family}`);
      }
      continue;
    }
    if (!isWildcardRole(key)) continue;
    if (!body || typeof body !== "object" || Array.isArray(body)) fail(t("matrix.notObject", { where: key }));
    // Preserve public difficulty lists for ordinary roles; ops roles only consume `*`.
    if (!isOpsRole(key)) {
      const tiers = parseTierMap(body, key);
      if (Object.keys(tiers).length > 0) starTiers[key] = tiers;
    }
    const starList = (body as Record<string, unknown>)["*"];
    if (starList == null) continue;
    if (!Array.isArray(starList)) fail(t("matrix.notArray", { where: `${key}.*` }));
    star[key] = starList.map((entry, index) => parseItem(entry, `${key}.*[${index}]`));
  }
  return {
    version: raw.version,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : null,
    defaultTier: raw.defaultTier,
    downgradeWhenTight,
    executor,
    reviewerFamilies,
    ...(reviewerModels !== undefined ? { reviewerModels } : {}),
    star,
    ...(Object.keys(starTiers).length > 0 ? { starTiers } : {}),
    priority: parseMatrixPriority(raw.priority),
  };
}

function readAt(path: string, now: number): MatrixLoad {
  let text: string;
  let mtime = 0;
  try {
    text = readFileSync(path, "utf8");
    mtime = statSync(path).mtimeMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "missing" };
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[paseo-kanban] dispatch matrix", detail);
    return { state: "invalid", message: matrixFailMessage(), detail, ageMs: null, updatedAt: null, path };
  }
  const ageMs = Math.max(0, now - mtime);
  const updatedAt = new Date(mtime).toISOString();
  try {
    const raw = JSON.parse(text) as unknown;
    const matrix = { ...parseDispatchMatrix(raw), ...contractAge(raw, now) };
    return { state: "ok", matrix, path };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[paseo-kanban] dispatch matrix", detail);
    return { state: "invalid", message: matrixFailMessage(), detail, ageMs, updatedAt, path };
  }
}

/** Staleness of a contract export by its envelope. Nothing for a legacy file without one. */
function contractAge(raw: unknown, now: number): { stale: boolean; ageMs: number } | Record<string, never> {
  if (!raw || typeof raw !== "object") return {};
  const { schema, generatedAt, ttlSeconds } = raw as Record<string, unknown>;
  if (schema !== CONTRACT_SCHEMA || typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt))) return {};
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return {};
  const envelope = { generatedAt, ttlSeconds };
  const at = new Date(now);
  return { stale: classifyFreshness(envelope, at) === "stale", ageMs: Math.round(envelopeAgeSeconds(envelope, at) * 1000) };
}

/** Admission uses the coherent immutable policy. An explicit path selects the compatibility reader. */
export function loadDispatchMatrix(now = Date.now(), path?: string | null): MatrixLoad {
  if (path === undefined) {
    const policy = readPolicy(now);
    if (policy.state !== "ok") return { state: "invalid", message: matrixFailMessage(), detail: policy.reason, ageMs: null, updatedAt: null, path: "policy-snapshot" };
    try {
      return { state: "ok", matrix: { ...parseDispatchMatrix(policy.snapshot.matrix), ...contractAge(policy.snapshot.matrix, now) }, path: "policy-snapshot" };
    } catch (error) { return { state: "invalid", message: matrixFailMessage(), detail: String(error), ageMs: null, updatedAt: null, path: "policy-snapshot" }; }
  }
  const file = path;
  if (!file) return { state: "missing" };
  return readAt(file, now);
}

/** Explicit anonymous compatibility fixture reader, distinct from the admission channel. */
export function readCompatibilityDispatchMatrix(now = Date.now(), path = matrixPath()): MatrixLoad {
  return path ? readAt(path, now) : { state: "missing" };
}
