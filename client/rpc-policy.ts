import { t } from "../shared/i18n";

/** Only audited, idempotent reads. Unknown methods and explicit actions never retry. */
const READS = new Set([
  "kanban.board", "kanban.decisions", "kanban.history", "kanban.task", "kanban.agents", "kanban.agent-link",
  "kanban.config.read", "kanban.leader-options", "kanban.leader-preview", "kanban.leader-status",
  "board.snapshot", "board.insights", "board.usage", "board.agent-link", "board.roles-page", "config.read",
  "roles.discover", "roles.preview",
]);
export function isReadRpc(method: string, input: unknown): boolean {
  if (READS.has(method)) return true;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const fields = Object.keys(input);
  if (["kanban.panel-prefs", "kanban.board-tab", "board.panel-prefs"].includes(method)) return fields.length === 0;
  return method === "board.access" && fields.every(key => key === "refresh") && [undefined, false].includes((input as { refresh?: unknown }).refresh as boolean | undefined);
}
export function isPluginUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error :
    error && typeof error === "object" && "message" in error ? String(error.message) : "";
  // handler_error alone also covers real server bugs. Match the unavailable diagnostic, not its envelope code.
  return /\bplugin\s+(?:is\s+)?not\s+available\b/i.test(message);
}
export class PluginUpdateError extends Error {
  constructor(read: boolean, cause: unknown) {
    super(t(read ? "rpc.update.readFailed" : "rpc.update.actionFailed"), { cause });
    this.name = "PluginUpdateError";
  }
}
export const READ_RETRY_DELAYS = [500, 1000, 2000, 4000, 6000] as const;
export const READ_RETRY_BUDGET_MS = 15_000;
type Runtime = { now: () => number; wait: (ms: number) => Promise<void> };
const runtime: Runtime = { now: Date.now, wait: ms => new Promise(resolve => setTimeout(resolve, ms)) };

async function withinBudget<T>(work: () => Promise<T>, remaining: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PluginUpdateError(true, "retry deadline")), Math.max(0, remaining));
    })]);
  } finally { clearTimeout(timer); }
}
/** A pending Promise leaves React Query's previous data intact until the new read succeeds or the bound expires. */
export async function callWithRetry<T>(method: string, input: unknown, work: () => Promise<T>, updating: (active: boolean) => void, clock: Runtime = runtime): Promise<T> {
  try { return await work(); } catch (error) {
    if (!isPluginUnavailable(error)) throw error;
    if (!isReadRpc(method, input)) throw new PluginUpdateError(false, error);
    const deadline = clock.now() + READ_RETRY_BUDGET_MS;
    let last = error;
    updating(true);
    try {
      for (const delay of READ_RETRY_DELAYS) {
        if (clock.now() + delay >= deadline) break;
        await clock.wait(delay);
        if (clock.now() >= deadline) break;
        try { return await withinBudget(work, deadline - clock.now()); } catch (next) {
          if (!isPluginUnavailable(next)) throw next;
          last = next;
        }
      }
      throw new PluginUpdateError(true, last);
    } finally { updating(false); }
  }
}
