import type { PaseoApi } from "./paseo-api";
import { isBusy } from "../../shared/fleet/supervisor-shift-format";

type Agent = Pick<ReturnType<PaseoApi["agents"]["ref"]>, "run" | "waitForFinish" | "timeline">;
type Result = Awaited<ReturnType<Agent["waitForFinish"]>>;
type Clock = { now(): number; sleep(ms: number): Promise<void> };
const clock: Clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** A host wait also ends when permission is requested. That is not the end of a leader's turn. */
export async function waitForLeaderTurn(agent: Agent, timeoutMs: number, prompt?: string, time: Clock = clock): Promise<Result> {
  const deadline = time.now() + timeoutMs;
  const before = prompt === undefined ? null : await agent.timeline.refetch({ direction: "tail", limit: 1 });
  if (before?.error) throw new Error(before.error);
  const initialBudget = deadline - time.now();
  if (initialBudget <= 0) return { status: "timeout", final: null, error: null, lastMessage: null };
  let result = prompt === undefined
    ? await agent.waitForFinish(initialBudget)
    : await agent.run(prompt, { timeoutMs: initialBudget });
  // The host lifecycle decides whether the turn is still running. A leftover
  // activeTurn marker on an idle agent is not waited on: the host itself treats
  // that agent as idle, so waiting would only run out the whole budget.
  while (result.status === "permission" || (result.status === "idle" && isBusy(result.final?.status ?? ""))) {
    // Pending permission can make waitForFinish resolve immediately. Never spin,
    // approve it here, resend the prompt, or grant another full timeout per wait.
    const remaining = deadline - time.now();
    if (remaining <= 0) return { ...result, status: "timeout", error: null, lastMessage: null };
    await time.sleep(Math.min(500, remaining));
    const next = deadline - time.now();
    if (next <= 0) return { ...result, status: "timeout", error: null, lastMessage: null };
    result = await agent.waitForFinish(next);
  }
  if (result.status === "idle" && ["closed", "error"].includes(result.final?.status ?? "")) {
    return { ...result, status: "error", error: "Leader session ended without a completed turn", lastMessage: null };
  }
  if (before && result.status === "idle") {
    const after = await agent.timeline.refetch({ direction: "tail", limit: 20 });
    if (after.error) throw new Error(after.error);
    // Sequence identity, not text equality: two legitimate acknowledgements can
    // have identical text. A replaced timeline cannot prove freshness.
    return { ...result, lastMessage: after.epoch === before.epoch ? lastReplySince(after.entries, before.window.maxSeq) : null };
  }
  return result;
}

type Entry = Awaited<ReturnType<Agent["timeline"]["refetch"]>>["entries"][number];

/** Like the host's own last message: the trailing run of adjacent assistant entries, joined. Only entries after `maxSeq` count. */
function lastReplySince(entries: readonly Entry[], maxSeq: number): string | null {
  const chunks: string[] = [];
  for (const entry of [...entries].reverse()) {
    if (entry.item.type !== "assistant_message") {
      if (chunks.length) break;
      continue;
    }
    if (entry.seqStart <= maxSeq) break;
    chunks.push(entry.item.text);
  }
  return chunks.length ? chunks.reverse().join("") : null;
}
