/// <reference types="node" />
import { providerBanned } from "../../shared/fleet/provider-policy";
import { readBannedProviders } from "./adapters/config";
import type { PaseoApi } from "./paseo-api";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BoardInsights, BoardPr } from "../../shared/fleet/board";
import { type AgentRecord, modelIdOf, readAgentRecords, readAllProfiles } from "./records";
import { transcriptFacts } from "./transcripts";
import { interruptedBy, restartTimes } from "./snapshot";
import {
  BIN, cached, HOME, clearCache, type Json, LEDGER, logSwallowed, mapLimit, readJson, repoOf, run, runJson, SEEN_MODELS, STATE_DIR, writeJson,
} from "./util";
import { createStaleCache } from "./stale-cache";
import { ADAPTER_PROVIDERS } from "../../shared/fleet/quota-adapters";
import { anyWord, punct } from "../../shared/fleet/decision-parse";
import { t } from "../../shared/fleet/i18n";

const DAY = 24 * 3600_000;
const SCORE_DAYS = 14;
/** Providers some quota adapter reads (shared/quota-adapters.ts). */
const PAID_PROVIDERS = ADAPTER_PROVIDERS;
const PROVIDER_REFRESH_MS = 6 * 3600_000;
/** git / gh processes run at once while collecting PRs. */
const LOOKUP_CONCURRENCY = 6;
/** Insights younger than this are served as they are; older ones are served once more while a rebuild runs. */
const INSIGHTS_FRESH_MS = 60_000;

// ---------------- helpers ----------------

/** Flag recent merges without a reviewer using a rolling window. */
export function isUnreviewedMerge(pr: Pick<BoardPr, "mergedAt" | "reviewerAgentId">, now = Date.now()): boolean {
  return Boolean(pr.mergedAt && now - Date.parse(pr.mergedAt) < 7 * DAY && !pr.reviewerAgentId);
}

function mentions(title: string, n: number): boolean {
  return new RegExp(`#${n}(?!\\d)|PR ?${n}(?!\\d)`).test(title);
}

function ciOf(rollup: Json[] | undefined): BoardPr["ci"] {
  if (!rollup || rollup.length === 0) return "none";
  const vals = rollup.map((c) => String(c.conclusion || c.state || c.status || "").toUpperCase());
  if (vals.some((v) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(v))) return "fail";
  if (vals.some((v) => ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING", ""].includes(v))) return "pending";
  return "pass";
}

type Verdict = "approve" | "changes" | "unknown";

/** Reviewer verdict words in every language (reviewers may answer in either). Built at use time from the catalogs. */
function verdictPatterns(): { approve: RegExp; changes: RegExp } {
  const noIssues = `${anyWord("insights.verdict.issueList")}[${punct(":")}]?\\s*${anyWord("insights.verdict.none")}`;
  return {
    approve: new RegExp(`${anyWord("insights.verdict.approve")}|${noIssues}|no (blocking )?issues`, "i"),
    changes: new RegExp(anyWord("insights.verdict.changes"), "i"),
  };
}

interface Facts { turns: number; verdict: Verdict }

/** Follow-up counts and review verdicts, read from provider transcript files (no Paseo calls). */
async function readFacts(records: AgentRecord[]): Promise<Record<string, Facts>> {
  const since = Date.now() - SCORE_DAYS * DAY;
  const out: Record<string, Facts> = {};
  const verdicts = verdictPatterns();
  for (const r of records) {
    if (!r.role || r.role === "supervisor" || !r.createdAt || Date.parse(r.createdAt) < since) continue;
    const f = await transcriptFacts(r).catch(() => null);
    if (!f) continue;
    const tail = f.lastReply.slice(-1500);
    const verdict: Verdict = r.role === "reviewer" ? (verdicts.changes.test(tail) ? "changes" : verdicts.approve.test(tail) ? "approve" : "unknown") : "unknown";
    out[r.id] = { turns: f.turns, verdict };
  }
  return out;
}

// ---------------- ⑥ unreviewed merges ----------------

async function pullRequests(records: AgentRecord[], logs: Record<string, Facts>): Promise<{ unreviewed: BoardPr[] }> {
  const since = Date.now() - SCORE_DAYS * DAY;
  // One git lookup per working directory and one gh call per repo, a few at a time (they were one by one:
  // about 6 s of git and 10 s of gh on 2026-10-07). First-seen order is kept, so the output does not change.
  const cwds = [...new Set(records.filter((r) => r.role && r.updatedAt && !(Date.parse(r.updatedAt) < since)).map((r) => r.cwd))];
  const repos = [...new Set((await mapLimit(cwds, LOOKUP_CONCURRENCY, repoOf)).filter((repo): repo is string => Boolean(repo)))];
  const lists = await mapLimit(repos, LOOKUP_CONCURRENCY, (repo) => cached(`prs:${repo}`, 120_000, () =>
    runJson<Json[]>(BIN.gh, ["pr", "list", "-R", repo, "--state", "all", "--limit", "10", "--json", "number,title,body,url,state,author,createdAt,mergedAt,statusCheckRollup,closingIssuesReferences"], 30_000),
  ).catch(() => [] as Json[]));
  const unreviewed: BoardPr[] = [];
  for (const [index, repo] of repos.entries()) {
    const prs = lists[index];
    for (const p of prs) {
      const n = Number(p.number);
      const linked = ((p.closingIssuesReferences ?? []) as Json[]).map((i) => Number(i.number));
      // PRs into a non-default branch (pre/preview) are not linked by GitHub, so also read "Closes #N" in the body.
      const inBody = [...String(p.body ?? "").matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((m) => Number(m[1]));
      const issues = [...new Set([...linked, ...inBody])].filter(Boolean);
      const byNewest = (a: AgentRecord, b: AgentRecord) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      const onPr = records.filter((r) => mentions(r.title, n)).sort(byNewest);
      const onIssue = records.filter((r) => issues.some((i) => mentions(r.title, i))).sort(byNewest);
      const isExec = (r: AgentRecord) => r.role === "executor";
      const exec = onPr.find(isExec) ?? onIssue.find(isExec) ?? null;
      const rev = onPr.find((r) => r.role === "reviewer") ?? onIssue.find((r) => r.role === "reviewer") ?? null;
      const pr: BoardPr = {
        repo,
        number: n,
        title: String(p.title ?? ""),
        url: String(p.url ?? ""),
        state: String(p.state ?? ""),
        author: String(p.author?.login ?? ""),
        createdAt: String(p.createdAt ?? ""),
        mergedAt: p.mergedAt ?? null,
        ci: ciOf(p.statusCheckRollup),
        executorAgentId: exec?.id ?? null,
        reviewerAgentId: rev?.id ?? null,
        reviewVerdict: rev ? (logs[rev.id]?.verdict ?? "unknown") : "none",
      };
      if (isUnreviewedMerge(pr)) unreviewed.push(pr);
    }
  }
  unreviewed.sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""));
  return { unreviewed };
}

// ---------------- ⑤ two bosses ----------------

function base32Decode(s: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.toUpperCase().replace(/=+$/, "")) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return "";
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes).toString("utf8");
}

/** Every bot still listed in Agent sandbox's sidebar. Archived bots drop out of this list. Read-only. */
async function sandboxAgentsRoster(): Promise<BoardInsights["sandboxAgents"]> {
  const dir = process.env.AFC_SANDBOX_ROSTER_DIR?.trim();
  if (!dir) return { readable: false, bots: [] };
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith(".blob")) continue;
    if (!base32Decode(f.slice(0, -5)).endsWith("roster.last-roster")) continue;
    const rows: Json[] = JSON.parse(await readFile(join(dir, f), "utf8"))?.value?.rows ?? [];
    const iso = (v: unknown) => (typeof v === "number" ? new Date(v).toISOString() : typeof v === "string" ? v : null);
    const bots = rows.map((r) => ({
      name: String(r.name ?? r.title ?? "?"),
      repo: /repo=「([^」]+)」/.exec(String(r.description ?? ""))?.[1] ?? null,
      lastActive: iso(r.lastActivityAt ?? r.updatedAt),
    }));
    bots.sort((x, y) => (y.lastActive ?? "").localeCompare(x.lastActive ?? ""));
    return { readable: true, bots };
  }
  return { readable: false, bots: [] };
}

// ---------------- ⑧ scorecard ----------------

function scorecard(records: AgentRecord[], logs: Record<string, Facts>, restarts: number[]): BoardInsights["scorecard"] {
  const since = Date.now() - SCORE_DAYS * DAY;
  const groups = new Map<string, BoardInsights["scorecard"][number] & { minutes: number[] }>();
  for (const r of records) {
    if (!r.role || r.role === "supervisor" || !r.createdAt || Date.parse(r.createdAt) < since) continue;
    const model = r.model ? `${r.provider}/${r.model}` : r.provider;
    if (providerBanned(r, readBannedProviders())) continue;
    const key = `${r.role}|${model}`;
    const g = groups.get(key) ?? { role: r.role, model, runs: 0, errors: 0, interrupted: 0, avgMinutes: null, followUps: 0, reviewsApproved: 0, reviewsChanges: 0, minutes: [] };
    g.runs += 1;
    if (r.lastError || r.attentionReason === "error") g.errors += 1;
    if (interruptedBy(r, restarts)) g.interrupted += 1;
    if (r.finishedAt) g.minutes.push(Math.min(600, Math.max(0, (Date.parse(r.finishedAt) - Date.parse(r.createdAt)) / 60_000)));
    const info = logs[r.id];
    if (info) {
      g.followUps += Math.max(0, info.turns - 1);
      if (info.verdict === "approve") g.reviewsApproved += 1;
      if (info.verdict === "changes") g.reviewsChanges += 1;
    }
    groups.set(key, g);
  }
  return [...groups.values()].map(({ minutes, ...g }) => ({
    ...g,
    avgMinutes: minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null,
  }));
}

// ---------------- ⑨ models ----------------

/**
 * Ask the daemon to re-read the providers' model lists, at most once every 6 h. Not awaited: on
 * 2026-10-07 the call never answered and timed out after 120 s on every round, and since a failure was
 * not cached, the insights RPC took 2 minutes each time. The lists below come back in milliseconds.
 */
function refreshProvidersInBackground(paseo: PaseoApi, providers: readonly string[]): void {
  void cached("providers-refresh", PROVIDER_REFRESH_MS, async () => {
    paseo.providers.refresh({ providers: [...providers] } as never)
      .then(() => {
        // The daemon has new lists: drop the 30-minute model cache and let the next read build new insights.
        clearCache("models:");
        insightsCache.invalidate();
      })
      .catch((error: unknown) => logSwallowed("insights: providers.refresh", error));
    return true;
  });
}

async function models(paseo: PaseoApi): Promise<{ models: BoardInsights["models"]; baselineAt: string | null }> {
  const profiles = await readAllProfiles();
  const providers = [...new Set([...PAID_PROVIDERS, ...profiles.map((profile) => profile.provider)])]
    .filter((provider) => provider && !providerBanned(provider, readBannedProviders()));
  refreshProvidersInBackground(paseo, providers);
  const policyKey = readBannedProviders().join("|");
  const found: Array<{ provider: string; id: string; label: string; thinking: string[] }> = [];
  for (const provider of providers) {
    const res = (await cached(`models:${provider}:${policyKey}`, 30 * 60_000, () => paseo.providers.listModels(provider as never)).catch(() => null)) as Json | null;
    for (const m of (res?.models ?? []) as Json[]) {
      if (m.isSelectable === false) continue;
      const id = String(m.id);
      const label = String(m.label ?? m.id);
      if (providerBanned({ provider, id, label }, readBannedProviders())) continue;
      found.push({ provider, id, label, thinking: ((m.thinkingOptions ?? []) as Json[]).map((t) => String(t.id)) });
    }
  }
  const seen = await readJson<{ baselineAt: string | null; seen: Record<string, string> }>(SEEN_MODELS, { baselineAt: null, seen: {} });
  const now = new Date().toISOString();
  if (!seen.baselineAt) seen.baselineAt = now;
  let changed = false;
  for (const m of found) {
    const key = `${m.provider}/${m.id}`;
    if (!seen.seen[key]) {
      seen.seen[key] = now;
      changed = true;
    }
  }
  if (changed) await writeJson(SEEN_MODELS, seen);
  const baseline = Date.parse(seen.baselineAt) + 60_000;
  return {
    baselineAt: seen.baselineAt,
    models: found.map((m) => {
      const key = `${m.provider}/${m.id}`;
      const firstSeen = seen.seen[key];
      const at = Date.parse(firstSeen);
      return {
        ...m,
        firstSeen,
        isNew: at > baseline && Date.now() - at < SCORE_DAYS * DAY,
        usedBy: profiles.filter((p) => modelIdOf(p) === key).map((p) => p.name),
      };
    }),
  };
}

// ---------------- entry ----------------

const insightsCache = createStaleCache<BoardInsights>({
  freshMs: INSIGHTS_FRESH_MS,
  onError: (error) => logSwallowed("insights: background refresh failed, keeping the previous one", error),
});

/** Last insights at once (rebuilt in the background when older than a minute); `force` waits for a new one. */
export function buildInsights(paseo: PaseoApi, force: boolean): Promise<BoardInsights> {
  return insightsCache.get(() => computeInsights(paseo), { force });
}

async function computeInsights(paseo: PaseoApi): Promise<BoardInsights> {
  const warnings: string[] = [];
  const [records, restarts] = await Promise.all([readAgentRecords(), restartTimes().catch(() => [] as number[])]);
  const allowed = records.filter((record) => !providerBanned(record, readBannedProviders()));
  const logs = await readFacts(allowed);
  const [prs, ov, mdl] = await Promise.all([
    pullRequests(allowed, logs).catch((e) => {
      warnings.push(t("insights.prReadFailed", { error: String(e).slice(0, 160) }));
      return { unreviewed: [] };
    }),
    cached("sandbox-agents-roster", 5 * 60_000, sandboxAgentsRoster).catch((e) => {
      warnings.push(t("insights.sandboxAgentsReadFailed", { error: String(e).slice(0, 160) }));
      return { readable: false, bots: [] };
    }),
    models(paseo).catch((e) => {
      warnings.push(t("insights.modelsReadFailed", { error: String(e).slice(0, 160) }));
      return { models: [], baselineAt: null };
    }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    unreviewedMerges: prs.unreviewed,
    sandboxAgents: ov,
    scorecard: scorecard(allowed, logs, restarts),
    models: mdl.models,
    modelsBaselineAt: mdl.baselineAt,
    warnings,
  };
}
