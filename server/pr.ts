/// <reference types="node" />
import { execFile } from "node:child_process";
import { KanbanError } from "./errors";
import { t } from "../shared/i18n";
import { dotSegment, githubRepository, projectRepository, type ProjectRepoContext } from "./project-repo";

export interface ContractState {
  kind: "local-only" | "github";
  repo: string | null;
  pr: string | null;
  awaiting: boolean;
}

export interface PrCheck {
  name: string;
  url: string | null;
  state: string;
}

export type PrVerdict =
  | { kind: "skip" }
  | { kind: "pass"; summary: string }
  | { kind: "wait"; summary: string }
  | { kind: "fail"; summary: string; checks: PrCheck[] }
  | { kind: "error"; summary: string };

export type GhRunner = (args: string[]) => Promise<string>;

const LOCAL: ContractState = { kind: "local-only", repo: null, pr: null, awaiting: false };

export function assertReadOnly(args: string[]): void {
  const [cmd, sub] = args;
  if (cmd === "pr" && sub === "view") return;
  // Any body field turns gh api into a POST, so every spelling of -f/-F/--field/--raw-field is refused, glued forms included.
  const writes = (arg: string) =>
    /^(-X|--method|--input)(=|$)/.test(arg) || /^(-f|-F|--field|--raw-field)(=|$)/.test(arg) || /^-[fFX]./.test(arg);
  if (cmd === "api" && !args.some(writes)) return;
  throw new Error(t("pr.gh.notReadOnly", { args: args.join(" ") }));
}

function realGh(args: string[]): Promise<string> {
  assertReadOnly(args);
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 20_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

let ghRunner: GhRunner = realGh;

export function setGhRunner(fn: GhRunner | null): void {
  ghRunner = fn ?? realGh;
}

export function readContract(raw: string | null | undefined): ContractState {
  if (!raw || !raw.trim()) return { ...LOCAL };
  const text = raw.trim();
  if (text === "local-only") return { ...LOCAL };
  if (text.startsWith("github:")) {
    const repo = text.slice("github:".length);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some(dotSegment)) throw new KanbanError("invalid", t("pr.contract.badRepo", { text }));
    return { kind: "github", repo, pr: null, awaiting: false };
  }
  try {
    const parsed = JSON.parse(text) as Partial<ContractState>;
    if (parsed.kind === "github" && typeof parsed.repo === "string") {
      return {
        kind: "github",
        repo: parsed.repo,
        pr: typeof parsed.pr === "string" ? parsed.pr : null,
        awaiting: parsed.awaiting === true,
      };
    }
    if (parsed.kind === "local-only") {
      return { kind: "local-only", repo: null, pr: typeof parsed.pr === "string" ? parsed.pr : null, awaiting: false };
    }
  } catch {
    throw new KanbanError("invalid", t("pr.contract.unreadable", { text }));
  }
  throw new KanbanError("invalid", t("pr.contract.badKind", { text }));
}

export function writeContract(state: ContractState): string {
  return JSON.stringify(state);
}

export function contractLabel(state: ContractState): string {
  return state.kind === "github" && state.repo ? `github:${state.repo}` : "local-only";
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi;

function prUrls(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [...value.matchAll(PR_URL)].map((match) => match[0]);
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return items.flatMap((item) => prUrls(item, seen));
}

// "PR #280", "PR#280", "PR: #280", "pull request #280". A bare "#280" or "issue #280" is never a PR.
// Also the Chinese words for "pull request" and "merge request", and the full-width colon and parenthesis.
const BARE_PR = /(?:\bPRs?|\bpull request|\u62c9\u53d6\u8bf7\u6c42|\u5408\u5e76\u8bf7\u6c42)[\s:\uff1a(\uff08]*#(\d+)\b/gi;

function bareNumbers(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [...value.matchAll(BARE_PR)].map((match) => match[1] ?? "");
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return items.flatMap((item) => bareNumbers(item, seen));
}

function decodedHandoff(handoff: unknown): unknown {
  if (typeof handoff !== "string") return handoff;
  try { return JSON.parse(handoff) as unknown; } catch { return handoff; }
}

function explicitPr(handoff: unknown): string | null {
  if (!handoff || typeof handoff !== "object") return null;
  const pr = (handoff as { pr?: unknown }).pr;
  return typeof pr === "string" && pr.trim() ? pr.trim() : null;
}

export function prFromHandoff(handoff: unknown): string | null {
  const decoded = decodedHandoff(handoff);
  return explicitPr(decoded) ?? prUrls(decoded).at(-1) ?? null;
}

export interface PrBindingDiagnostics {
  ignoredPr?: Array<{ url: string; reason: string }>;
  prCandidates?: string[];
}

export interface PrBindingContext extends ProjectRepoContext {
  diagnostics?: PrBindingDiagnostics;
}

export function parsePrUrl(url: string): { owner: string; repo: string; number: string } | null {
  const match = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/i);
  if (!match || dotSegment(match[1] ?? "") || dotSegment(match[2] ?? "")) return null;
  return { owner: match[1] ?? "", repo: match[2] ?? "", number: match[3] ?? "" };
}

/** Only a GitHub PR URL imposes a merge dependency, regardless of contract kind. */
export function contractPullRequest(state: ContractState): string | null {
  return state.pr && parsePrUrl(state.pr) ? state.pr : null;
}

function canonPr(url: string): string {
  return url.replace(/\/$/, "").toLowerCase();
}

export function rememberPullRequest(raw: string | null, handoff: unknown, summary?: unknown, context?: PrBindingContext): ContractState {
  const state = readContract(raw);
  const repo = state.repo ? githubRepository(state.repo) : context ? projectRepository(context) : null;
  const decoded = decodedHandoff(handoff);
  const explicit = explicitPr(decoded);
  const urls = [...new Set([...prUrls(decoded), ...prUrls(summary), ...(explicit ? [explicit] : [])].reverse())].reverse();
  const candidates: string[] = [];
  const ignoredPr: NonNullable<PrBindingDiagnostics["ignoredPr"]> = [];
  // Without an explicit handoff.pr or an earlier binding, a bare "PR #N" is completed with the project repository.
  // Full links come later in the list, so they still win as the last candidate.
  if (!explicit && !state.pr) {
    const numbers = [...new Set([...bareNumbers(decoded), ...bareNumbers(summary)])];
    const completed: string[] = [];
    for (const number of numbers) {
      if (!repo) ignoredPr.push({ url: `#${number}`, reason: "project_repository_unknown_or_no_origin" });
      else completed.push(`https://github.com/${repo}/pull/${number}`);
    }
    urls.unshift(...completed.filter((url) => !urls.some((known) => canonPr(known) === canonPr(url))));
  }
  for (const url of urls) {
    const parsed = parsePrUrl(url);
    const reason = !parsed ? "invalid_pr_url"
      : !repo ? "project_repository_unknown_or_no_origin"
      : `${parsed.owner}/${parsed.repo}`.toLowerCase() !== repo.toLowerCase() ? `repository_mismatch: expected ${repo}` : null;
    if (reason) ignoredPr.push({ url, reason });
    else candidates.push(url);
  }
  if (context?.diagnostics) {
    if (ignoredPr.length) context.diagnostics.ignoredPr = ignoredPr;
    if (candidates.length > 1) context.diagnostics.prCandidates = candidates;
  }
  // An explicit field is authoritative, even when it points at the wrong repository.
  const incoming = explicit ? candidates.find((url) => url === explicit) ?? null : candidates.at(-1) ?? null;
  if (state.kind !== "github") return incoming && !state.pr ? { ...state, pr: incoming } : state;
  if (!state.repo || !repo) throw new KanbanError("pr_required", t("pr.contract.noRepo"));
  if (state.pr && incoming && canonPr(state.pr) !== canonPr(incoming)) {
    throw new KanbanError("pr_bound", t("pr.contract.alreadyBound", { pr: state.pr, incoming }));
  }
  const pr = state.pr ?? incoming;
  if (!pr) throw new KanbanError("pr_required", t("pr.contract.needPr"));
  const parsed = parsePrUrl(pr);
  if (!parsed || `${parsed.owner}/${parsed.repo}`.toLowerCase() !== repo.toLowerCase()) {
    throw new KanbanError("pr_required", t("pr.contract.wrongRepo", { repo: state.repo }));
  }
  return { ...state, pr };
}

interface CheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string | null;
}

interface StatusRow {
  context?: string;
  state?: string;
  target_url?: string | null;
}

function contextsFromProtection(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const checks = body as { required_status_checks?: { contexts?: string[]; checks?: Array<{ context?: string }> } };
  const names = [...(checks.required_status_checks?.contexts ?? [])];
  for (const check of checks.required_status_checks?.checks ?? []) {
    if (check.context) names.push(check.context);
  }
  return names;
}

function contextsFromRules(body: unknown): string[] {
  const rules = Array.isArray(body) ? body : [];
  const names: string[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const row = rule as { type?: string; parameters?: { required_status_checks?: Array<{ context?: string }> } };
    if (row.type !== "required_status_checks") continue;
    for (const check of row.parameters?.required_status_checks ?? []) {
      if (check.context) names.push(check.context);
    }
  }
  return names;
}

function asCheckRuns(body: unknown): CheckRun[] {
  if (Array.isArray(body)) return body.flatMap((page) => asCheckRuns(page));
  if (body && typeof body === "object" && Array.isArray((body as { check_runs?: unknown }).check_runs)) {
    return (body as { check_runs: CheckRun[] }).check_runs;
  }
  return [];
}

const PASS = new Set(["success"]);

function classify(name: string, run: CheckRun | undefined, status: StatusRow | undefined): PrCheck & { bucket: "pass" | "wait" | "fail" } {
  if (run) {
    const state = run.status && run.status !== "completed" ? run.status : (run.conclusion ?? "missing");
    const bucket = PASS.has(String(run.conclusion)) ? "pass" : run.status && run.status !== "completed" ? "wait" : "fail";
    return { name, url: run.html_url ?? null, state: state || "missing", bucket };
  }
  if (status) {
    const state = status.state ?? "missing";
    const bucket = state === "success" ? "pass" : state === "pending" ? "wait" : "fail";
    return { name, url: status.target_url ?? null, state, bucket };
  }
  return { name, url: null, state: "missing", bucket: "wait" };
}

/**
 * `gh api --paginate` without `--slurp` prints each page as its own JSON value, back to back.
 * Read a single value as usual; otherwise read the values one after another and return them as an array of pages.
 */
export function parseJsonPages(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (first) {
    const pages: unknown[] = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth < 0) throw first;
        if (depth === 0) pages.push(JSON.parse(text.slice(start, i + 1)) as unknown);
      } else if (depth === 0 && !/\s/.test(ch)) throw first;
    }
    if (depth !== 0 || pages.length === 0) throw first;
    return pages;
  }
}

async function ghJson(args: string[], run: GhRunner, allowMissing = false): Promise<unknown | null> {
  try {
    return parseJsonPages(await run(args)) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (allowMissing && /404|not found|branch not protected|no rules/i.test(message)) return null;
    throw err;
  }
}

/** The poll round ran out of time. Not a gh failure, so it never starts a backoff. */
class BudgetExhausted extends Error {
  constructor() {
    super(t("pr.budget.exhausted"));
  }
}

interface CheckData {
  checkedAt: number;
  checks: CheckRun[];
  statuses: StatusRow[];
}

/** The checks of one head commit are reused for this long. Both calls are paged and can be slow. */
export const CHECK_CACHE_MS = 90_000;

interface CheckBucket {
  cache: Map<string, CheckData>;
  errors: Map<string, { count: number; retryAt: number; error: string }>;
}

/** Per runner, so a test that swaps the gh runner never sees another runner's answers. Production has one runner. */
const checkBuckets = new Map<GhRunner, CheckBucket>();

export function resetCheckCache(): void {
  checkBuckets.clear();
}

function checkBucket(run: GhRunner): CheckBucket {
  let bucket = checkBuckets.get(run);
  if (!bucket) {
    bucket = { cache: new Map(), errors: new Map() };
    checkBuckets.set(run, bucket);
  }
  return bucket;
}

/** Every check and status of a commit, all pages. Cached; after gh errors the commit backs off like a merge check does. */
async function commitChecks(repo: string, sha: string, run: GhRunner, call: GhRunner, now: number, deadline: number | null): Promise<CheckData> {
  const key = `${repo.toLowerCase()}@${sha}`;
  const { cache, errors } = checkBucket(run);
  const hit = cache.get(key);
  if (hit && now - hit.checkedAt < CHECK_CACHE_MS) return hit;
  const backoff = errors.get(key);
  if (backoff && now < backoff.retryAt) throw new Error(t("pr.gh.backoff", { error: backoff.error }));
  try {
    const checks = asCheckRuns(
      await ghJson(["api", "--paginate", "--slurp", `repos/${repo}/commits/${sha}/check-runs?per_page=100`], call),
    );
    if (deadline !== null && Date.now() > deadline) throw new BudgetExhausted();
    const statuses = asStatusRows(
      await ghJson(["api", "--paginate", "--slurp", `repos/${repo}/commits/${sha}/statuses?per_page=100`], call),
    );
    const data = { checkedAt: now, checks, statuses };
    cache.set(key, data);
    errors.delete(key);
    return data;
  } catch (err) {
    if (err instanceof BudgetExhausted) throw err;
    const error = err instanceof Error ? err.message : String(err);
    const count = (errors.get(key)?.count ?? 0) + 1;
    const wait = MERGE_BACKOFF_MS[Math.min(count, MERGE_BACKOFF_MS.length) - 1];
    errors.set(key, { count, retryAt: now + wait, error });
    throw err;
  }
}

function asStatusRows(body: unknown): StatusRow[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((item) => (Array.isArray(item) ? asStatusRows(item) : item && typeof item === "object" ? [item as StatusRow] : []));
}

export interface EvaluateOptions {
  /** Epoch ms after which no new gh call is started. The caller's poll round shares one deadline. */
  deadline?: number;
}

export async function evaluateContract(state: ContractState, run: GhRunner = ghRunner, options: EvaluateOptions = {}): Promise<PrVerdict> {
  if (state.kind !== "github") return { kind: "skip" };
  if (!state.repo || !state.pr) return { kind: "error", summary: t("pr.contract.noPrBound") };
  const parsed = parsePrUrl(state.pr);
  if (!parsed) return { kind: "error", summary: t("pr.url.unparsable", { url: state.pr }) };
  const repo = `${parsed.owner}/${parsed.repo}`;
  const deadline = options.deadline ?? null;
  const budgeted: GhRunner = (args) => {
    if (deadline !== null && Date.now() > deadline) return Promise.reject(new BudgetExhausted());
    return run(args);
  };
  try {
    const viewArgs = ["pr", "view", parsed.number, "--repo", repo, "--json", "url,headRefOid,headRefName"];
    const first = (await ghJson(viewArgs, budgeted)) as { url?: string; headRefOid?: string; headRefName?: string } | null;
    const sha = first?.headRefOid;
    const branch = first?.headRefName;
    if (!sha || !branch) return { kind: "error", summary: t("pr.gh.noHead") };
    const protection = await ghJson(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`], budgeted, true);
    const rules = await ghJson(["api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`], budgeted, true);
    const required = [...new Set([...contextsFromProtection(protection), ...contextsFromRules(rules)])];
    if (required.length === 0) {
      return { kind: "error", summary: t("pr.checks.noneRequired", { repo }) };
    }
    const { checks, statuses: statusList } = await commitChecks(repo, sha, run, budgeted, Date.now(), deadline);
    const again = (await ghJson(viewArgs, budgeted)) as { headRefOid?: string } | null;
    if (again?.headRefOid && again.headRefOid !== sha) return { kind: "error", summary: t("pr.checks.headMoved") };
    const rows = required.map((name) => {
      const found = checks.find((item) => item.name === name);
      const legacy = statusList.find((item) => item.context === name);
      return classify(name, found, legacy);
    });
    const failed = rows.filter((row) => row.bucket === "fail");
    const waiting = rows.filter((row) => row.bucket === "wait");
    if (failed.length > 0) {
      const summary = t("pr.checks.failed", { checks: failed.map((row) => t("pr.checks.item", { name: row.name, state: row.state })).join(t("common.listSep")) });
      return { kind: "fail", summary, checks: failed.map(({ name, url, state }) => ({ name, url, state })) };
    }
    if (waiting.length > 0) {
      return { kind: "wait", summary: t("pr.checks.running", { checks: waiting.map((row) => t("pr.checks.item", { name: row.name, state: row.state })).join(t("common.listSep")) }) };
    }
    return { kind: "pass", summary: t("pr.checks.passed", { checks: rows.map((row) => row.name).join(t("common.listSep")) }) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", summary: t("pr.gh.queryFailed", { message }) };
  }
}

export interface HeadPullRequest {
  url: string | null;
  merged: boolean;
  headOid: string | null;
  error: string | null;
}

export interface MergeState {
  merged: boolean;
  /** Closed without a merge. Cached with the same TTL as an open PR. */
  closed: boolean;
  mergedAt: string | null;
  /** Set when gh failed. The caller treats the PR as not merged and asks again next round. */
  error: string | null;
}

interface MergeCacheEntry {
  checkedAt: number;
  closed: boolean;
  merged: boolean;
  mergedAt: string | null;
}

/** An open PR is asked again after this long. A merged PR stays cached, since merging cannot be undone. */
export const MERGE_CACHE_MS = 10 * 60_000;

/** After 1, 2, then 3 or more gh errors in a row, wait this long before asking about that PR again. */
export const MERGE_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

const mergeCache = new Map<string, MergeCacheEntry>();
const mergeErrors = new Map<string, { count: number; retryAt: number; error: string }>();
/** One gh call per PR at a time. A second caller gets the same promise. */
const mergeInflight = new Map<string, Promise<MergeState>>();

/** A merged pull request found by head branch. Errors are not cached, so the next round can ask again. */
const headCache = new Map<string, HeadPullRequest>();

export function resetMergeCache(): void {
  mergeCache.clear();
  mergeErrors.clear();
  mergeInflight.clear();
  headCache.clear();
}

/** What the cache last saw, without calling gh. Null means nobody has asked yet. */
export function cachedMergeState(prUrl: string): MergeState | null {
  const hit = mergeCache.get(canonPr(prUrl));
  return hit ? { merged: hit.merged, closed: hit.closed, mergedAt: hit.mergedAt, error: null } : null;
}

export function mergeCheckInFlight(prUrl: string): boolean {
  return mergeInflight.has(canonPr(prUrl));
}

/** When the next gh call for this PR is allowed after errors. Null when it is not backing off. */
export function mergeRetryAt(prUrl: string): number | null {
  return mergeErrors.get(canonPr(prUrl))?.retryAt ?? null;
}

/** The last gh failure for this PR, if it is still backing off. Null when the last check succeeded. */
export function mergeError(prUrl: string, now = Date.now()): string | null {
  const row = mergeErrors.get(canonPr(prUrl));
  if (!row || now >= row.retryAt) return null;
  return row.error;
}

/** Count one more gh failure for this PR and push the next try back. Also used when a caller gives up waiting. */
export function noteMergeError(prUrl: string, error: string, now = Date.now()): void {
  const key = canonPr(prUrl);
  const count = (mergeErrors.get(key)?.count ?? 0) + 1;
  const wait = MERGE_BACKOFF_MS[Math.min(count, MERGE_BACKOFF_MS.length) - 1] ?? MERGE_BACKOFF_MS[MERGE_BACKOFF_MS.length - 1];
  mergeErrors.set(key, { count, retryAt: now + wait, error });
}

/**
 * Whether a PR is merged. Shared by every card that waits on a merge.
 * Read-only gh and cached. An error counts as not merged; after errors the PR
 * backs off 1, 5, then 30 minutes. Concurrent callers share one gh call.
 */
export function prMergeState(prUrl: string, options: { now?: number; run?: GhRunner; cacheMs?: number } = {}): Promise<MergeState> {
  const now = options.now ?? Date.now();
  const key = canonPr(prUrl);
  const hit = mergeCache.get(key);
  if (hit && (hit.merged || now - hit.checkedAt < (options.cacheMs ?? MERGE_CACHE_MS))) {
    return Promise.resolve({ merged: hit.merged, closed: hit.closed, mergedAt: hit.mergedAt, error: null });
  }
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return Promise.resolve({ merged: false, closed: false, mergedAt: null, error: t("pr.url.unparsable", { url: prUrl }) });
  const backoff = mergeErrors.get(key);
  if (backoff && now < backoff.retryAt) {
    return Promise.resolve({ merged: false, closed: false, mergedAt: null, error: t("pr.gh.backoff", { error: backoff.error }) });
  }
  const pending = mergeInflight.get(key);
  if (pending) return pending;
  const job = (async (): Promise<MergeState> => {
    try {
      const body = (await ghJson(
        ["pr", "view", parsed.number, "--repo", `${parsed.owner}/${parsed.repo}`, "--json", "state,mergedAt"],
        options.run ?? ghRunner,
      )) as { state?: string; mergedAt?: string | null } | null;
      const mergedAt = typeof body?.mergedAt === "string" && body.mergedAt ? body.mergedAt : null;
      const merged = body?.state === "MERGED" || mergedAt !== null;
      const closed = body?.state === "CLOSED" && !merged;
      mergeCache.set(key, { checkedAt: now, merged, closed, mergedAt });
      mergeErrors.delete(key);
      return { merged, closed, mergedAt, error: null };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      noteMergeError(prUrl, error, now);
      return { merged: false, closed: false, mergedAt: null, error };
    }
  })();
  mergeInflight.set(key, job);
  void job.finally(() => {
    if (mergeInflight.get(key) === job) mergeInflight.delete(key);
  });
  return job;
}

/** The commit a PR's head points at, read with gh. Not cached: it is only asked right before a forced branch delete. */
export async function prHeadOid(prUrl: string, run: GhRunner = ghRunner): Promise<{ oid: string } | { error: string }> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return { error: t("pr.url.unparsable", { url: prUrl }) };
  try {
    const body = (await ghJson(["pr", "view", parsed.number, "--repo", `${parsed.owner}/${parsed.repo}`, "--json", "headRefOid"], run)) as {
      headRefOid?: unknown;
    } | null;
    const oid = typeof body?.headRefOid === "string" ? body.headRefOid.trim() : "";
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(oid)) return { error: t("pr.gh.noHeadOid") };
    return { oid: oid.toLowerCase() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function validOid(value: unknown): string | null {
  const oid = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid) ? oid : null;
}

/**
 * The pull request for a head branch, read with `gh pr view <branch>`.
 * A merged result is cached. A failure is not, so cleanup can ask again.
 */
export async function prByHead(branch: string, repo: string, options: { now?: number; run?: GhRunner } = {}): Promise<HeadPullRequest> {
  const key = `${repo.toLowerCase()}\n${branch}`;
  const cached = headCache.get(key);
  if (cached) return cached;
  try {
    const body = (await ghJson(
      ["pr", "view", branch, "--repo", repo, "--json", "state,mergedAt,url,headRefOid"],
      options.run ?? ghRunner,
    )) as { state?: string; mergedAt?: string | null; url?: unknown; headRefOid?: unknown } | null;
    const mergedAt = typeof body?.mergedAt === "string" && body.mergedAt ? body.mergedAt : null;
    const merged = body?.state === "MERGED" || mergedAt !== null;
    const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim() : null;
    const value: HeadPullRequest = { url, merged, headOid: validOid(body?.headRefOid), error: null };
    if (merged) headCache.set(key, value);
    if (url) mergeCache.set(canonPr(url), { checkedAt: options.now ?? Date.now(), merged, closed: body?.state === "CLOSED" && !merged, mergedAt });
    return value;
  } catch (err) {
    return { url: null, merged: false, headOid: null, error: err instanceof Error ? err.message : String(err) };
  }
}
