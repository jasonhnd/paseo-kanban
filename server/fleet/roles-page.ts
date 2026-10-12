/// <reference types="node" />
import { readBannedProviders } from "./adapters/config";
// Data and actions behind the Roles tab. Reads config, pool status and Kanban runs; the only write goes
// through `roles set`, which does its own checks and is never given --force. Swaps made here are recorded in
// the page history (server/roles-history.ts) so they can be undone the same way.
import { join } from "node:path";
import { t } from "../../shared/fleet/i18n";
import { poolNames } from "../../shared/fleet/quota-adapters";
import { readPoolCatalog } from "./adapters/plans";
import { applyDispatchMatrix, countRunsToday, type DispatchMatrix, type DispatchProfile, type PoolFlags } from "../../shared/fleet/dispatch";
import { type HistoryEntry, historyViews, type ModelSpec, modelSpecText } from "../../shared/fleet/roles-history";
import { buildRolesPage, countWeekTasks, PAGE_ROLES, profilesOnPage, type RolesPage, WEEK_MS } from "../../shared/fleet/roles-page";
import { swapRefusal } from "../../shared/fleet/roles-policy";
import { loadBaseMatrix, loadProfiles, poolFlagsFromJson } from "./dispatch";
import { readProfileRunsSince } from "./kanban";
import { POOL_STATUS } from "./pools";
import { fileHistoryStore, type HistoryStore, newHistoryId } from "./roles-history";
import { rolesBin } from "./paths";
import { type Json, logSwallowed, readJson, runOutcome, type RunOutcome } from "./util";
import { loadDispatchSettings } from "./dispatch-settings";
import type { ThinkingCatalog } from "../../shared/fleet/dispatch-overrides";

export const ROLES_BIN = rolesBin();
const ROLES_SET_TIMEOUT_MS = 90_000;

export interface RolesPageDeps {
  bannedProviders?: () => readonly string[];
  profiles: () => Promise<DispatchProfile[] | null>;
  pools: () => Promise<Record<string, PoolFlags>>;
  runsSince: (sinceIso: string) => Array<{ profile: string; at: string; taskId?: number | null }>;
  baseMatrix: () => Promise<DispatchMatrix>;
  dispatchSettings?: (profiles: readonly DispatchProfile[]) => Promise<{ dispatchOverrides: unknown; thinkingCatalog: ThinkingCatalog }>;
  /** Page history; absent means none is shown. */
  history?: () => Promise<HistoryEntry[]>;
  /** Pool id → display name. Absent means pools show their id. */
  poolLabels?: () => Promise<Record<string, string>>;
}

const historyStore = fileHistoryStore();

export function productionRolesPageDeps(): RolesPageDeps {
  return {
    bannedProviders: readBannedProviders,
    profiles: loadProfiles,
    pools: async () => poolFlagsFromJson(((await readJson<Json>(POOL_STATUS, {})).pools ?? {}) as Record<string, Json>),
    runsSince: (sinceIso) => readProfileRunsSince(sinceIso),
    baseMatrix: loadBaseMatrix,
    dispatchSettings: loadDispatchSettings,
    history: historyStore.read,
    poolLabels: async () => poolNames(await readPoolCatalog(), "label"),
  };
}

/** What a profile runs now, in the shape the history keeps. */
export function specOf(profile: DispatchProfile): ModelSpec {
  return { provider: profile.provider ?? "", model: profile.model ?? "", thinking: profile.thinkingOptionId ?? null };
}

function currentSpecs(profiles: readonly DispatchProfile[]): (name: string) => ModelSpec | null {
  const byName = new Map(profiles.map((profile) => [profile.name, specOf(profile)] as const));
  return (name) => byName.get(name) ?? null;
}

export async function buildRolesPageView(deps: RolesPageDeps = productionRolesPageDeps(), now = Date.now()): Promise<RolesPage> {
  const profiles = await deps.profiles();
  const generatedAt = new Date(now).toISOString();
  if (!profiles) {
    const empty = buildRolesPage({ profiles: [], pools: {}, todayRuns: {}, matrix: null, generatedAt });
    return { ...empty, warnings: [t("roles.server.noConfig")] };
  }
  const pools = await deps.pools();
  // One read covers both counts: the 7-day window always contains today (Tokyo).
  const runs = deps.runsSince(new Date(now - WEEK_MS).toISOString());
  const base = await deps.baseMatrix().catch((error: unknown) => {
    logSwallowed("roles page base matrix", error);
    return null;
  });
  const dispatchSettings = await deps.dispatchSettings?.(profiles);
  const matrix = base ? applyDispatchMatrix(base, { ...dispatchSettings, knownNames: new Set(profiles.map((profile) => profile.name)), profiles, pools, generatedAt, bannedProviders: deps.bannedProviders?.() }) : null;
  const entries = deps.history ? await deps.history().catch((error: unknown) => { logSwallowed("roles history read", error); return []; }) : [];
  const history = historyViews(entries, currentSpecs(profiles));
  const poolLabels = deps.poolLabels ? await deps.poolLabels().catch((error: unknown) => { logSwallowed("roles page pool labels", error); return {}; }) : {};
  return buildRolesPage({ bannedProviders: deps.bannedProviders?.(), profiles, pools, todayRuns: countRunsToday(runs, now), weekTasks: countWeekTasks(runs, now), history, matrix, generatedAt, poolLabels });
}

export interface RolesSetInput {
  profile: string;
  provider: string;
  model: string;
  thinking: string | null;
}

export interface RolesSetResult {
  ok: boolean;
  message: string;
  before: string | null;
  after: string | null;
}

export interface RolesSetDeps {
  bannedProviders?: () => readonly string[];
  profiles: () => Promise<DispatchProfile[] | null>;
  runRoles: (args: string[]) => Promise<RunOutcome>;
  /** Where page swaps are recorded; absent means they are not. */
  history?: HistoryStore;
  now?: () => number;
  newId?: () => string;
}

export function productionRolesSetDeps(): RolesSetDeps {
  return { bannedProviders: readBannedProviders, profiles: loadProfiles, runRoles: (args) => runOutcome(ROLES_BIN, args, ROLES_SET_TIMEOUT_MS), history: historyStore };
}

const refused = (message: string): RolesSetResult => ({ ok: false, message, before: null, after: null });

/** `<name> (<role>): <before>` then `  -> <after>  family=…`, as `roles set` prints them. */
export function parseSetOutput(stdout: string): { before: string | null; after: string | null } {
  const before = /^.+? \([a-z_]+\): (.+)$/m.exec(stdout)?.[1]?.trim() ?? null;
  const after = /^\s+-> (.+?)(?:\s+family=\S+)?$/m.exec(stdout)?.[1]?.trim() ?? null;
  return { before, after };
}

/** Failure text for the panel: the validation lines `roles set` printed, then its final error line. */
export function failureText(outcome: RunOutcome): string {
  const lines = outcome.stdout.split("\n").filter((line) => /^\[(FAIL|WARN)\]/.test(line)).map((line) => line.trim());
  const tail = outcome.timedOut ? t("roles.server.setTimedOut") : outcome.error ?? t("roles.server.setFailed");
  return [...lines, tail].join("\n");
}

export async function setRoleModel(input: RolesSetInput, deps: RolesSetDeps = productionRolesSetDeps()): Promise<RolesSetResult> {
  return swap(input, deps, null);
}

/** Runs `roles set`; on success records `old → new` with `undoOf` when it reverts an earlier entry. */
async function swap(input: RolesSetInput, deps: RolesSetDeps, undoOf: string | null): Promise<RolesSetResult> {
  const reason = swapRefusal(input.provider, input.model, input.thinking, deps.bannedProviders?.());
  if (reason) return refused(reason);
  const profiles = await deps.profiles();
  if (!profiles) return refused(t("roles.server.noConfigNoSwap"));
  const target = PAGE_ROLES.flatMap((key) => profilesOnPage(key, profiles, deps.bannedProviders?.())).find((profile) => profile.name === input.profile);
  if (!target) return refused(t("roles.server.noProfile", { profile: input.profile }));
  const args = ["set", target.name, `${input.provider}/${input.model}`, ...(input.thinking ? ["--thinking", input.thinking] : [])];
  const outcome = await deps.runRoles(args);
  if (!outcome.ok) return refused(failureText(outcome));
  const { before, after } = parseSetOutput(outcome.stdout);
  const from = specOf(target);
  // Without --thinking, `roles set` keeps the old level.
  const to: ModelSpec = { provider: input.provider, model: input.model, thinking: input.thinking ?? from.thinking };
  const recordNote = await record(deps, { profile: target.name, from, to, undoOf });
  const done = undoOf ? t("roles.server.undoDone", { name: target.name, spec: modelSpecText(to) }) : t("roles.server.swapDone", { name: target.name });
  return { ok: true, message: `${done}${recordNote}`, before, after };
}

/** Empty when recorded (or no store); otherwise a note for the panel. The swap itself already happened. */
async function record(deps: RolesSetDeps, change: Omit<HistoryEntry, "id" | "at">): Promise<string> {
  if (!deps.history) return "";
  const entry: HistoryEntry = { id: (deps.newId ?? newHistoryId)(), at: new Date((deps.now ?? Date.now)()).toISOString(), ...change };
  try {
    await deps.history.append(entry);
    return "";
  } catch (error) {
    logSwallowed("roles history write", error);
    return t("roles.server.historyNotRecorded");
  }
}

/** Undo: change the profile back to the entry's old value, only while it still runs the entry's new value. */
export async function undoRoleChange(id: string, deps: RolesSetDeps = productionRolesSetDeps()): Promise<RolesSetResult> {
  if (!deps.history) return refused(t("roles.server.noHistory"));
  const entries = await deps.history.read();
  const entry = entries.find((item) => item.id === id);
  if (!entry) return refused(t("roles.server.entryMissing"));
  const profiles = await deps.profiles();
  if (!profiles) return refused(t("roles.server.noConfigNoUndo"));
  const block = historyViews(entries, currentSpecs(profiles)).find((view) => view.id === id)?.undoBlock ?? null;
  if (block) return refused(t("roles.server.cannotUndo", { reason: block }));
  return swap({ profile: entry.profile, provider: entry.from.provider, model: entry.from.model, thinking: entry.from.thinking }, deps, entry.id);
}
