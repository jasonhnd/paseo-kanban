import { providerBanned } from "./provider-policy";
// Roles tab: every role, every profile that can serve it, and the order dispatch tries them in.
// Pure functions plus the two RPC shapes. The server fills them from config, pool status and the Kanban runs.
import { CURSOR_PROVIDER } from "./quota-adapters";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  displayProfileName,
  type DispatchMatrix,
  type DispatchProfile,
  roleLabel,
  orderProfiles,
  poolLabel,
  type MatrixEntry,
  type PoolFlags,
  statusOf,
  eligibleReviewers,
} from "./dispatch";
import { historyForProfiles, type HistoryView, historyViewSchema } from "./roles-history";
import { dispatchSlotLabel } from "./dispatch-slots";
import { t, tAll } from "./i18n";
import { companyName, cursorNotUsed } from "./roles-policy";

export const PATROL_KEY = "patrol";

/** The roles the page shows, in page order. Same as ROLE_ORDER plus the patrol role. */
export const PAGE_ROLES = [
  "supervisor",
  "executor",
  "reviewer",
  "reader",
  "decision",
  "batch",
  "ops_vercel",
  "ops_cloudflare",
  "ops_github",
  "ops_notion",
  PATROL_KEY,
] as const;

export function pageRoleLabel(key: string): string {
  return key === PATROL_KEY ? t("roles.page.patrol") : roleLabel(key) ?? key;
}

const rowSchema = z.object({
  /** Exact profile name; what `roles set` takes. */
  profile: z.string(),
  name: z.string(),
  isMain: z.boolean(),
  provider: z.string(),
  company: z.string(),
  /** Whose quota it spends: Claude / ChatGPT / Grok / Cursor. */
  quota: z.string(),
  model: z.string(),
  thinking: z.string().nullable(),
  pool: z.string(),
  status: z.enum(["prefer", "ready", "paused"]),
  statusText: z.string(),
  todayRuns: z.number(),
  /** Cards this profile ran in the last 7 days (a card run twice counts once). */
  weekTasks: z.number(),
});

const cardSchema = z.object({
  key: z.string(),
  label: z.string(),
  rows: z.array(rowSchema),
  /** Small print under the card: who is tried first, per difficulty. */
  orderLines: z.array(z.string()),
  /** Swaps made from this page for the card's profiles, newest first. */
  history: z.array(historyViewSchema),
});

export const rolesPageRpc = defineRpc({
  name: "board.roles-page",
  input: z.object({}),
  output: z.object({ generatedAt: z.string(), cards: z.array(cardSchema), warnings: z.array(z.string()) }),
});

export const rolesSetRpc = defineRpc({
  name: "board.roles-set",
  input: z.object({
    profile: z.string().trim().min(1).max(200),
    provider: z.string().trim().min(1).max(60),
    model: z.string().trim().min(1).max(200),
    thinking: z.string().trim().max(40).nullable(),
  }),
  /** `before` / `after` are the one-line descriptions `roles set` printed; null when the change was refused. */
  output: z.object({ ok: z.boolean(), message: z.string(), before: z.string().nullable(), after: z.string().nullable() }),
});

export type RolesPage = z.infer<typeof rolesPageRpc.output>;
export type RoleCardView = z.infer<typeof cardSchema>;
export type RoleRowView = z.infer<typeof rowSchema>;

/** Main profile of the role, then stand-ins that point at it. Personal and legacy profiles are not listed. */
export function profilesOnPage(roleKey: string, profiles: readonly DispatchProfile[], bannedProviders: readonly string[] = []): DispatchProfile[] {
  return profiles.filter((profile) => {
    if (profile.role === "personal") return false;
    if (providerBanned(profile, bannedProviders)) return false;
    return profile.role === roleKey || (profile.role === "candidate" && profile.candidateFor === roleKey);
  });
}

const QUOTA_BY_PROVIDER: Record<string, string> = { claude: "Claude", codex: "ChatGPT", grok: "Grok", cursor: "Cursor" };

/** Plan name the user pays for, from the provider; unknown providers fall back to the company. */
export function quotaName(provider: string, company: string): string {
  return QUOTA_BY_PROVIDER[provider] ?? company;
}

interface RunCounts {
  today: Record<string, number>;
  week: Record<string, number>;
}

function rowOf(roleKey: string, profile: DispatchProfile, pools: Record<string, PoolFlags>, counts: RunCounts, poolLabels: Readonly<Record<string, string>>): RoleRowView {
  const pool = profile.pool ? pools[profile.pool] : undefined;
  const status = statusOf(profile, pool);
  // Pool closed on purpose (the Cursor plan's dispatch=false in plans.json, DEMO_0098): say so instead of echoing the pool note.
  const company = companyName(profile.provider ?? "", profile.model ?? "", profile.family);
  const cursorClosed = profile.provider === CURSOR_PROVIDER && pool?.dispatchable === false;
  return {
    profile: profile.name,
    name: roleKey === "supervisor" && profile.role === roleKey ? "<leader>" : displayProfileName(profile.name),
    isMain: profile.role === roleKey,
    provider: profile.provider ?? "",
    company,
    quota: quotaName(profile.provider ?? "", company),
    model: profile.model ?? "?",
    thinking: profile.thinkingOptionId ?? null,
    pool: poolLabel(profile.pool, poolLabels),
    status: status.status,
    statusText: cursorClosed ? cursorNotUsed() : status.text,
    todayRuns: counts.today[profile.name] ?? 0,
    weekTasks: counts.week[profile.name] ?? 0,
  };
}

/** Short name inside a role card: the role prefix is dropped, the main profile is "Main profile". */
function shortName(name: string, roleKey: string): string {
  const label = pageRoleLabel(roleKey);
  const clean = dispatchSlotLabel(name) ?? displayProfileName(name);
  if (clean === label || tAll("roles.page.legacyLeader").includes(clean)) return t("roles.page.mainProfile");
  return clean.startsWith(`${label} · `) ? clean.slice(label.length + 3) : clean;
}

function isEntries(value: unknown): value is MatrixEntry[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" && typeof (item as MatrixEntry).profile === "string");
}

const TIER_KEY = /^L[1-4]$/;

function entryText(entry: MatrixEntry, roleKey: string): string {
  return `${shortName(entry.profile, roleKey)}${entry.paused ? t("roles.page.paused") : ""}`;
}

/** First profile that is not paused for each tier, e.g. `L1 GPT-6.1-Sol · L2 …`. */
function firstPerTier(node: Record<string, unknown>, roleKey: string): string {
  const parts = ["L1", "L2", "L3", "L4"]
    .filter((tier) => Object.hasOwn(node, tier) || isEntries(node["*"]))
    .map((tier) => {
      const list = node[tier] ?? node["*"];
      const first = isEntries(list) ? list.find((entry) => !entry.paused) : undefined;
      return `${tier} ${first ? shortName(first.profile, roleKey) : t("roles.page.allPaused")}`;
    });
  return parts.join(" · ");
}

function isTierNode(node: unknown): node is Record<string, unknown> {
  return Boolean(node) && typeof node === "object" && !Array.isArray(node) && Object.keys(node as object).some((key) => TIER_KEY.test(key));
}

const FAMILY_LABEL: Record<string, string> = { xai: "xAI", anthropic: "Anthropic", openai: "OpenAI" };

/** Lines of small print about dispatch order. Empty roles say so in one line. */
export function orderLines(roleKey: string, matrix: DispatchMatrix | null, rowCount: number,
  profiles: readonly DispatchProfile[] = [], pools: Record<string, PoolFlags> | null = null, bannedProviders: readonly string[] = []): string[] {
  const node = matrix?.roles?.[roleKey];
  if (roleKey === "reviewer" && node && typeof node === "object" && Object.hasOwn(node, "byExecutorModel")) {
    const byModel = (node as { byExecutorModel?: Record<string, unknown> }).byExecutorModel;
    if (!byModel || typeof byModel !== "object" || Array.isArray(byModel)) return [t("roles.page.noOrder")];
    return Object.entries(byModel).map(([model, tiers]) => {
      const safe = profiles.length && matrix && tiers && typeof tiers === "object" ? Object.fromEntries(Object.keys(tiers).map(tier =>
        [tier, eligibleReviewers(matrix, model, tier, profiles, pools, bannedProviders)])) : tiers;
      return t("roles.page.orderModel", { model, list: isTierNode(safe) ? firstPerTier(safe, roleKey) : t("roles.page.allPaused") });
    });
  }
  if (isEntries(node) && node.length > 0) return [t("roles.page.orderFlat", { list: node.map((entry) => entryText(entry, roleKey)).join(" → ") })];
  if (isTierNode(node)) return [t("roles.page.orderTier", { list: firstPerTier(node, roleKey) })];
  const byFamily = (node as { byExecutorFamily?: Record<string, unknown> } | undefined)?.byExecutorFamily;
  if (byFamily && typeof byFamily === "object") {
    return Object.entries(byFamily).map(([family, tiers]) => t("roles.page.orderFamily", { family: FAMILY_LABEL[family] ?? family, list: isTierNode(tiers) ? firstPerTier(tiers, roleKey) : "?" }));
  }
  const anyKey = node && typeof node === "object" ? Object.values(node as object).find(isEntries) : undefined;
  if (anyKey && anyKey.length > 0) return [t("roles.page.orderFlat", { list: anyKey.map((entry) => entryText(entry, roleKey)).join(" → ") })];
  return [t(rowCount <= 1 ? "roles.page.onlyOne" : "roles.page.noOrder")];
}

export const WEEK_MS = 7 * 24 * 3600_000;

/** Distinct cards each profile ran in the 7 days up to `now`. Runs without a card id count one each. */
export function countWeekTasks(runs: ReadonlyArray<{ profile: string; at: string; taskId?: number | null }>, now: number): Record<string, number> {
  const seen = new Map<string, Set<string>>();
  runs.forEach((run, index) => {
    const t = Date.parse(run.at);
    if (!run.profile || Number.isNaN(t) || t < now - WEEK_MS || t > now) return;
    const cards = seen.get(run.profile) ?? new Set<string>();
    cards.add(run.taskId === null || run.taskId === undefined ? `run:${index}` : String(run.taskId));
    seen.set(run.profile, cards);
  });
  return Object.fromEntries([...seen.entries()].map(([profile, cards]) => [profile, cards.size]));
}

export function buildRolesPage(input: {
  profiles: readonly DispatchProfile[];
  bannedProviders?: readonly string[];
  pools: Record<string, PoolFlags>;
  todayRuns: Record<string, number>;
  weekTasks?: Record<string, number>;
  history?: readonly HistoryView[];
  matrix: DispatchMatrix | null;
  generatedAt: string;
  /** Pool id → display name (shared/quota-adapters.ts poolNames(catalog, "label")). */
  poolLabels?: Readonly<Record<string, string>>;
}): RolesPage {
  const counts = { today: input.todayRuns, week: input.weekTasks ?? {} };
  const cards = PAGE_ROLES.map((key) => {
    const ordered = orderProfiles(profilesOnPage(key, input.profiles, input.bannedProviders), input.pools);
    const rows = ordered.map((profile) => rowOf(key, profile, input.pools, counts, input.poolLabels ?? {}));
    const history = historyForProfiles(input.history ?? [], rows.map((row) => row.profile));
    return { key, label: pageRoleLabel(key), rows, orderLines: orderLines(key, input.matrix, rows.length, input.profiles, input.pools, input.bannedProviders), history };
  });
  const warnings = cards.filter((card) => card.rows.length === 0).map((card) => t("roles.page.noProfilesWarning", { label: card.label }));
  return { generatedAt: input.generatedAt, cards, warnings };
}
