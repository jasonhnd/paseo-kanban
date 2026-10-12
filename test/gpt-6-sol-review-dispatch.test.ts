// Anonymous closed loop for the independent Codex gpt-6-sol reviewer slot.
// Default rows, override recognition, producer export, contract schema, then consumer selection.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DispatchMatrix as ExportMatrix } from "../shared/contract/schema";
import { applyDispatchMatrix, eligibleReviewers, firstDispatchable, type DispatchMatrix, type DispatchProfile, type ReviewerModelMatrix } from "../shared/fleet/dispatch";
import { dispatchOverridesSchema } from "../shared/fleet/dispatch-overrides";
import { dispatchSlotLabel, resolveProfileToken } from "../shared/fleet/dispatch-slots";
import { setLanguage as setFleetLanguage } from "../shared/fleet/i18n";
import { closeDb } from "../server/db";
import { loadConfig, saveConfig } from "../server/config";
import { buildDispatchMatrixExport } from "../server/fleet/exports";
import { parseDispatchMatrix } from "../server/matrix";
import { openEntry } from "../server/pools";
import type { Profile } from "../server/profiles";
import { routeProfile, type RouteInput } from "../server/routing";

const SLOT = "reviewer.gpt-6-sol";
const TIERS = ["L1", "L2", "L3", "L4"] as const;
const dir = mkdtempSync(join(tmpdir(), "gpt6sol-review-"));
const savedData = process.env.KANBAN_DATA_DIR;
process.env.KANBAN_DATA_DIR = dir;
mkdirSync(join(dir, "fleet"));

const base: DispatchMatrix = JSON.parse(readFileSync(new URL("../shared/fleet/default-dispatch.example.json", import.meta.url), "utf8"));
const preserved: Record<(typeof TIERS)[number], Array<[string, string]>> = {
  L1: [["reviewer", "low"], ["reviewer.gpt-6.1-sol", "medium"], ["reviewer.grok", "low"]],
  L2: [["reviewer", "medium"], ["reviewer.gpt-6.1-sol", "high"], ["reviewer.grok", "medium"]],
  L3: [["reviewer", "high"], ["reviewer.gpt-6.1-sol", "xhigh"], ["reviewer.grok", "high"]],
  L4: [["reviewer.fable", "xhigh"], ["reviewer.gpt-6.1-sol", "xhigh"], ["reviewer.grok", "xhigh"]],
};

function reviewerRows(tier: string): Array<{ profile: string; effort: string | null }> {
  const rows = (base.roles.reviewer as Record<string, unknown>)[tier];
  assert.ok(Array.isArray(rows));
  return rows as Array<{ profile: string; effort: string | null }>;
}

function fleet(partial: Partial<DispatchProfile> & Pick<DispatchProfile, "name">): DispatchProfile {
  return { provider: "demo", pool: "demo", ...partial };
}

const executor61 = fleet({ name: "Anon executor 61", role: "candidate", candidateFor: "executor", provider: "codex", family: "openai", model: "gpt-6.1-sol" });
const executorSol = fleet({ name: "Anon executor sol", role: "candidate", candidateFor: "executor", provider: "codex", family: "openai", model: "gpt-6-sol", thinkingOptionId: "high" });
const executorMain = fleet({ name: "Anon executor", role: "executor", provider: "demo", family: "demo", model: "demo-executor" });
// findProfile also accepts a unique name prefix. These names must not extend "Anon reviewer".
const reviewerMain = fleet({ name: "Anon reviewer", role: "reviewer", provider: "claude", family: "anthropic", model: "claude-sonnet-5" });
const reviewer61 = fleet({ name: "Anon 61 reviewer", role: "candidate", candidateFor: "reviewer", provider: "codex", family: "openai", model: "gpt-6.1-sol" });
const reviewerGrok = fleet({ name: "Anon grok reviewer", role: "candidate", candidateFor: "reviewer", provider: "grok", family: "xai", model: "grok-4.7" });
const reviewerFable = fleet({ name: "Anon fable reviewer", role: "candidate", candidateFor: "reviewer", provider: "claude", family: "anthropic", model: "claude-fable-5", notes: "High risk" });
const reviewerSol = fleet({ name: "Anon sol reviewer", role: "candidate", candidateFor: "reviewer", provider: "codex", family: "openai", model: "gpt-6-sol" });
const profiles = [executor61, executorSol, executorMain, reviewerMain, reviewer61, reviewerGrok, reviewerFable, reviewerSol];
const catalog = Object.fromEntries(profiles.map(profile => [profile.name, ["low", "medium", "high", "xhigh"]]));
const options = { profiles, knownNames: new Set(profiles.map(profile => profile.name)), pools: null, generatedAt: "2030-01-01T00:00:00.000Z", thinkingCatalog: catalog };

function branches(matrix: DispatchMatrix): ReviewerModelMatrix["byExecutorModel"] {
  return (matrix.roles.reviewer as ReviewerModelMatrix).byExecutorModel;
}

function kanban(profile: DispatchProfile, extra: Partial<Profile> = {}): Profile {
  return {
    id: profile.name, name: profile.name, provider: profile.provider ?? "demo", role: profile.role, candidateFor: profile.candidateFor ?? undefined,
    family: profile.family ?? undefined, model: profile.model ?? undefined, pool: profile.pool ?? "demo", thinkingOptionId: profile.thinkingOptionId ?? undefined, notes: profile.notes, ...extra,
  };
}

function route(executor: DispatchProfile, reviewers: Profile[], tier: string, matrix: ReturnType<typeof parseDispatchMatrix>, executorModel: unknown = executor.model) {
  const input: RouteInput = {
    role: "reviewer", review: true, reviewsExecutor: true, tier, executorFamily: executor.family ?? null,
    executorModel: typeof executorModel === "string" || executorModel == null ? executorModel : null,
    executorProfile: executor.name, executorProvider: executor.provider ?? null,
    profiles: [kanban(executor), ...reviewers], byPool: {}, poolLimits: { demo: 10 },
    snapshot: { state: "fresh", generatedAt: null, message: "anonymous", dispatchable: () => true, hasPool: () => true, entry: () => openEntry() },
    matrix,
  };
  return routeProfile(input);
}

before(() => {
  saveConfig({ ...loadConfig(), families: {}, bannedProviders: { providers: [], families: [], pools: [], models: [] }, disabledPools: [], concurrency: { global: 10, roles: { reviewer: 10 }, pools: { demo: 10 } } });
});
after(() => {
  closeDb();
  if (savedData === undefined) delete process.env.KANBAN_DATA_DIR;
  else process.env.KANBAN_DATA_DIR = savedData;
  rmSync(dir, { recursive: true, force: true });
});

test("the shipped reviewer default appends an independent gpt-6-sol slot at xhigh on every tier", () => {
  for (const role of ["executor", "reader", "decision", "batch", "ops_vercel", "ops_cloudflare", "ops_github", "ops_notion"]) {
    assert.equal(JSON.stringify(base.roles[role]).includes(SLOT), false);
  }
  for (const tier of TIERS) {
    const rows = reviewerRows(tier);
    assert.deepEqual(rows.slice(0, preserved[tier].length).map(row => [row.profile, row.effort]), preserved[tier]);
    assert.deepEqual(rows.at(-1), { profile: SLOT, effort: "xhigh" });
  }
  const en = JSON.parse(readFileSync(new URL("../shared/locales/en/fleet.json", import.meta.url), "utf8")) as Record<string, string>;
  const zh = JSON.parse(readFileSync(new URL("../shared/locales/zh-CN/fleet.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(en["dispatch.slot.reviewerGpt6Sol"], "Reviewer · GPT-6-Sol");
  assert.equal(zh["dispatch.slot.reviewerGpt6Sol"], zh["dispatch.slot.reviewerGpt"].replace("6.1-", "6-"));
  setFleetLanguage("en");
  assert.equal(dispatchSlotLabel(SLOT), en["dispatch.slot.reviewerGpt6Sol"]);
  setFleetLanguage("zh-CN");
  assert.equal(dispatchSlotLabel(SLOT), zh["dispatch.slot.reviewerGpt6Sol"]);
  setFleetLanguage("en");
});

test("slot matching is the exact Codex model and does not borrow the gpt-6.1 marker", () => {
  const sol = fleet({ name: "Anon reviewer sol", role: "candidate", candidateFor: "reviewer", provider: "codex", model: " GPT-6-Sol " });
  const dotted = fleet({ name: "Reviewer GPT-6-Sol", role: "candidate", candidateFor: "reviewer", provider: "codex", model: "gpt-6.1-sol" });
  const namedOnly = fleet({ name: "Reviewer GPT-6.1-Sol", role: "candidate", candidateFor: "reviewer", provider: "codex", model: "gpt-6-sol" });
  assert.equal(resolveProfileToken(SLOT, [sol])?.model, " GPT-6-Sol ");
  assert.equal(resolveProfileToken("reviewer.gpt-6.1-sol", [sol]), null);
  assert.equal(resolveProfileToken(SLOT, [dotted]), null);
  assert.equal(resolveProfileToken("reviewer.gpt-6.1-sol", [dotted])?.name, dotted.name);
  assert.equal(resolveProfileToken(SLOT, [namedOnly])?.name, namedOnly.name);
  assert.equal(resolveProfileToken("reviewer.gpt-6.1-sol", [fleet({ name: "Anon reviewer sol", role: "candidate", candidateFor: "reviewer", provider: "codex", model: "gpt-6-sol" })]), null);
  for (const blocked of [
    fleet({ name: "Anon reviewer sol", role: "candidate", candidateFor: "reviewer", provider: "codex", model: "gpt-6-sol-preview" }),
    fleet({ name: "Anon reviewer sol", role: "candidate", candidateFor: "reviewer", provider: "other", model: "gpt-6-sol" }),
    fleet({ name: "Anon reviewer sol", role: "candidate", candidateFor: "reviewer", provider: "codex", model: " " }),
    fleet({ name: "Anon reviewer sol", role: "candidate", candidateFor: "reviewer", provider: "codex", model: null }),
    fleet({ name: "Anon executor sol", role: "candidate", candidateFor: "executor", provider: "codex", model: "gpt-6-sol" }),
  ]) assert.equal(resolveProfileToken(SLOT, [blocked]), null);
});

test("default, override, export, schema and consumer selection keep the new slot and the old gates", () => {
  const warnings: string[] = [];
  const plain = applyDispatchMatrix(base, options);
  const models = branches(plain);
  for (const model of ["gpt-6.1-sol", "demo-executor", "grok-4.7", "claude-sonnet-5", "claude-fable-5"]) {
    for (const tier of TIERS) {
      const row = models[model][tier].find(entry => entry.profile === reviewerSol.name);
      assert.equal(row?.effort, "xhigh", `${model}/${tier}`);
      assert.equal(row?.order, undefined);
    }
  }
  for (const tier of TIERS) assert.equal(models["gpt-6-sol"][tier].some(entry => entry.profile === reviewerSol.name), false);
  for (const tier of TIERS) {
    assert.equal(models["demo-executor"][tier].some(entry => entry.profile === reviewer61.name), true);
    assert.equal(models["gpt-6.1-sol"][tier].some(entry => entry.profile === reviewer61.name), false);
    assert.equal(models["gpt-6-sol"][tier].some(entry => entry.profile === reviewer61.name), true);
  }
  for (const tier of ["L1", "L2", "L3"] as const) assert.equal(models["demo-executor"][tier].some(entry => entry.profile === reviewerMain.name), true);
  assert.equal(models["gpt-6.1-sol"].L4.some(entry => entry.profile === reviewerMain.name), false);
  assert.equal(models["gpt-6.1-sol"].L4.some(entry => entry.profile === reviewerFable.name), true);
  assert.equal(models["gpt-6.1-sol"].L4.some(entry => entry.profile === reviewerGrok.name), true);
  assert.deepEqual(models["gpt-6.1-sol"].L1.map(entry => entry.profile), [reviewerMain.name, reviewerGrok.name, reviewerSol.name]);

  const overrides = { reviewer: { L1: { [SLOT]: { order: 1 } }, L4: { [SLOT]: { order: 1 } } } };
  assert.equal(dispatchOverridesSchema.safeParse(overrides).success, true);
  const moved = applyDispatchMatrix(base, { ...options, dispatchOverrides: overrides, onOverrideWarning: message => warnings.push(message) });
  assert.deepEqual(warnings, []);
  const movedSol = branches(moved)["gpt-6.1-sol"];
  assert.equal(movedSol.L1[0].profile, reviewerSol.name);
  assert.equal(movedSol.L1[0].order, 1);
  assert.equal(movedSol.L1[0].effort, "xhigh");
  assert.equal(movedSol.L4[0].profile, reviewerSol.name);
  assert.equal(branches(moved)["demo-executor"].L2.find(entry => entry.profile === reviewer61.name)?.effort, "high");
  const ignored: string[] = [];
  const untouched = applyDispatchMatrix(base, { ...options, dispatchOverrides: { reviewer: { L1: { "reviewer.gpt-6": { order: 1 } } } }, onOverrideWarning: message => ignored.push(message) });
  assert.match(ignored[0], /reviewer\.gpt-6/);
  assert.deepEqual(branches(untouched)["gpt-6.1-sol"].L1, models["gpt-6.1-sol"].L1);
  const onlyOld = applyDispatchMatrix(base, { ...options, dispatchOverrides: { reviewer: { L3: { "reviewer.gpt-6.1-sol": { effort: "high" } } } } });
  assert.equal(branches(onlyOld)["demo-executor"].L3.find(entry => entry.profile === reviewer61.name)?.effort, "high");
  assert.equal(branches(onlyOld)["demo-executor"].L3.find(entry => entry.profile === reviewerSol.name)?.effort, "xhigh");

  const exported = buildDispatchMatrixExport(plain, "0.0.0-demo", new Date("2030-01-01T00:00:00.000Z"));
  const parsed = ExportMatrix.parse(exported);
  assert.equal("byExecutorModel" in parsed.roles.reviewer, true);
  assert.equal("byExecutorFamily" in parsed.roles.reviewer, false);
  const consumed = parseDispatchMatrix(parsed);
  assert.equal(consumed.reviewerModels?.["gpt-6.1-sol"]?.L2?.find(entry => entry.profile === reviewerSol.name)?.effort, "xhigh");
  assert.equal(consumed.reviewerModels?.["gpt-6-sol"]?.L4?.some(entry => entry.profile === reviewerSol.name), false);

  const selected = route(executor61, [kanban(reviewerSol)], "L2", consumed);
  assert.equal(selected.ok, true);
  if (!selected.ok) return;
  assert.equal(selected.profile.name, reviewerSol.name);
  assert.equal(selected.effort, "xhigh");
  const spaced = route(executor61, [kanban(reviewerSol)], "L4", consumed, " GPT-6.1-Sol ");
  assert.equal(spaced.ok && spaced.profile.name, reviewerSol.name);
  const sameFamily = route(executorSol, [kanban(reviewer61)], "L2", consumed);
  assert.equal(sameFamily.ok && sameFamily.profile.name, reviewer61.name);
  assert.equal(sameFamily.ok && sameFamily.effort, "high");
  assert.equal(route(executorSol, [kanban(reviewerSol)], "L4", consumed).ok, false);
  assert.equal(route(executorSol, [kanban(reviewerSol, { provider: "other", thinkingOptionId: "low", modeId: "other-mode" })], "L1", consumed).ok, false);
  assert.equal(route(executor61, [kanban(reviewerSol, { model: "gpt-6.1-sol", provider: "other", thinkingOptionId: "low", modeId: "other-mode" })], "L1", consumed).ok, false);
  assert.equal(route(executor61, [kanban(reviewerSol, { model: "" })], "L1", consumed).ok, false);
  assert.equal(route(executor61, [kanban(reviewerSol, { model: " " })], "L1", consumed).ok, false);
  assert.equal(route(executor61, [kanban(reviewerSol, { model: undefined })], "L3", consumed).ok, false);
  const recordedFallback = route(executor61, [kanban(reviewerSol)], "L1", consumed, null);
  assert.equal(recordedFallback.ok && recordedFallback.profile.name, reviewerSol.name);
  assert.equal(route({ ...executor61, model: " " }, [kanban(reviewerSol)], "L1", consumed, null).ok, false);
  assert.equal(route(executor61, [kanban(reviewerSol)], "L1", consumed, "   ").ok, false);
  assert.equal(route(executor61, [kanban(reviewerSol, { paused: true })], "L2", consumed).ok, false);
  assert.equal(route(executor61, [], "L2", consumed).ok, false);

  const paused = { ...reviewerSol, name: "Anon paused sol", notes: "[Paused]" };
  const pausedMatrix = applyDispatchMatrix(base, { ...options, profiles: [executor61, paused], knownNames: new Set([executor61.name, paused.name]) });
  const pausedRows = eligibleReviewers(pausedMatrix, "gpt-6.1-sol", "L1", [executor61, paused], null);
  assert.equal(pausedRows.find(entry => entry.profile === paused.name)?.paused, true);
  assert.equal(firstDispatchable(pausedRows.filter(entry => entry.profile === paused.name)), null);
  const pausedExport = ExportMatrix.parse(buildDispatchMatrixExport(pausedMatrix, "0.0.0-demo", new Date("2030-01-01T00:00:00.000Z")));
  const pausedConsumed = parseDispatchMatrix(pausedExport);
  assert.equal(route(executor61, [kanban(paused, { paused: true })], "L1", pausedConsumed).ok, false);
});
