/// <reference types="node" />
import { DEFAULT_AUTO_ARCHIVE_AFTER_MS, loadConfig, type KanbanConfig } from "./config";
import { t } from "../shared/i18n";
import { getDb } from "./db";
import {
  cachedMergeState,
  contractPullRequest,
  mergeCheckInFlight,
  mergeRetryAt,
  noteMergeError,
  prMergeState,
  readContract,
  type GhRunner,
} from "./pr";
import { autoArchiveTask, finishedAt, type TaskRow } from "./store";

export interface AutoArchiveOptions {
  now?: Date;
  config?: KanbanConfig;
  /** Tests pass a fake gh. Absent uses the shared read-only runner in pr.ts. */
  run?: GhRunner;
}

/*
 * Merge checks run in the background so gh never holds up the scheduler.
 * autoArchiveDone only reads what an earlier check found and queues a new one;
 * runTick does not wait for gh. At most MERGE_CHECK_CONCURRENCY checks run at once.
 * A check that takes longer than the timeout gives its slot back and counts as a
 * gh error (so the PR backs off), while prMergeState keeps the PR in flight until
 * gh returns, so the same PR is never asked twice at the same time.
 */
export const MERGE_CHECK_CONCURRENCY = 2;
export const MERGE_CHECK_TIMEOUT_MS = 30_000;

interface MergeCheck {
  pr: string;
  now: number;
  run?: GhRunner;
}

const queue: MergeCheck[] = [];
const queued = new Set<string>();
const pending = new Set<Promise<void>>();
let active = 0;
let checkTimeoutMs = MERGE_CHECK_TIMEOUT_MS;

function keyOf(pr: string): string {
  return pr.replace(/\/$/, "").toLowerCase();
}

/** Tests shorten the timeout. Null puts the default back. */
export function setMergeCheckTimeout(ms: number | null): void {
  checkTimeoutMs = ms ?? MERGE_CHECK_TIMEOUT_MS;
}

/** Drops queued checks. Checks already running finish on their own. */
export function resetMergeChecks(): void {
  queue.length = 0;
  queued.clear();
}

/** Wait for the checks running now, and any they start. For tests. */
export async function flushMergeChecks(): Promise<void> {
  for (let i = 0; i < 100 && pending.size > 0; i += 1) await Promise.all([...pending]);
}

/** Queue a read-only merge check. Shared by auto-archive and by cards waiting on a parent PR. */
export function watchPullRequest(pr: string, now = Date.now(), run?: GhRunner): void {
  requestMergeCheck({ pr, now, run });
}

function requestMergeCheck(check: MergeCheck): void {
  if (cachedMergeState(check.pr)?.merged) return;
  if (mergeCheckInFlight(check.pr)) return;
  const retryAt = mergeRetryAt(check.pr);
  if (retryAt !== null && check.now < retryAt) return;
  const key = keyOf(check.pr);
  if (queued.has(key)) return;
  queued.add(key);
  queue.push(check);
  pump();
}

function pump(): void {
  while (active < MERGE_CHECK_CONCURRENCY && queue.length > 0) {
    const check = queue.shift();
    if (!check) break;
    queued.delete(keyOf(check.pr));
    if (mergeCheckInFlight(check.pr)) continue;
    active += 1;
    const job = runCheck(check).finally(() => {
      active -= 1;
      pump();
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }
}

const mergeListeners = new Set<(pr: string) => void>();

/** Called as soon as a background check sees a PR merged, so cards waiting on it need not wait for the next tick. */
export function onPullRequestMerged(listener: (pr: string) => void): void {
  mergeListeners.add(listener);
}

function runCheck(check: MergeCheck): Promise<void> {
  const answer = prMergeState(check.pr, { now: check.now, run: check.run }).then((state) => {
    if (!state.merged) return;
    for (const listener of mergeListeners) {
      try {
        listener(check.pr);
      } catch (err) {
        console.error("[paseo-kanban] merge listener", err instanceof Error ? err.message : err);
      }
    }
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      noteMergeError(check.pr, t("autoArchive.ghTimeout"), check.now);
      resolve();
    }, checkTimeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    void answer.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function afterMs(config: KanbanConfig): number {
  const value = config.autoArchiveAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_AUTO_ARCHIVE_AFTER_MS;
}

function later(a: string, b: string | null): string {
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/**
 * Done cards turn archived once they have sat in done long enough.
 * A card with a GitHub PR waits for its PR to merge, then the same wait starts from the merge.
 * The merge comes from an earlier background check; until one says merged, the card stays.
 * Never waits on gh.
 */
export function autoArchiveDone(options: AutoArchiveOptions = {}): number[] {
  const now = options.now ?? new Date();
  const wait = afterMs(options.config ?? loadConfig());
  const rows = getDb().prepare(`SELECT * FROM tasks WHERE status = 'done' ORDER BY id`).all() as unknown as TaskRow[];
  const archived: number[] = [];
  for (const task of rows) {
    try {
      const done = finishedAt(task);
      const contract = readContract(task.contract_json);
      let since = done;
      let mergedAt: string | null = null;
      const pr = contractPullRequest(contract);
      if (pr) {
        watchPullRequest(pr, now.getTime(), options.run);
        const merge = cachedMergeState(pr);
        if (!merge?.merged) continue;
        mergedAt = merge.mergedAt;
        since = later(done, mergedAt);
      }
      if (now.getTime() - Date.parse(since) < wait) continue;
      const moved = autoArchiveTask(task.id, "scheduler", { doneAt: done, ...(mergedAt ? { mergedAt } : {}) });
      if (moved) archived.push(task.id);
    } catch (err) {
      console.error("[paseo-kanban] auto archive", err instanceof Error ? err.message : err);
    }
  }
  return archived;
}
