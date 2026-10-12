import { agentCwdMissing, noteWakeSkipped } from "./missing-cwd";

type WakeSender = (agentId: string, text: string) => unknown;

let sender: WakeSender = () => {};
let senderReady = false;

export function setWakeSender(fn: WakeSender): void {
  sender = fn;
  senderReady = true;
}

/** Tests put the bus back to "no Paseo client yet". A wake in that state must stay retryable. */
export function resetWakeSender(): void {
  sender = () => {};
  senderReady = false;
}

/** False until a Paseo client has been bound. A wake before that must not count as sent. */
export function hasWakeSender(): boolean {
  return senderReady;
}

function rejected(err: unknown): false {
  console.error("[paseo-kanban] wake", err instanceof Error ? err.message : err);
  return false;
}

/**
 * Send once. A plain sender answers at once with true or false; an async sender answers with a
 * promise that never rejects. Callers that must write their record right after a synchronous
 * send use this; everyone else uses deliverWake.
 */
export function sendWake(agentId: string, text: string): boolean | Promise<boolean> {
  const missing = agentCwdMissing(agentId);
  if (missing) {
    noteWakeSkipped(null, agentId, missing, "deliver");
    return false;
  }
  try {
    const result = sender(agentId, text);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return Promise.resolve(result).then(() => true, rejected);
    }
    return true;
  } catch (err) {
    return rejected(err);
  }
}

/** Resolves true only after the sender accepts the text. A rejection is not a delivery. */
export function deliverWake(agentId: string, text: string): Promise<boolean> {
  return Promise.resolve(sendWake(agentId, text));
}
