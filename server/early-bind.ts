/// <reference types="node" />

/** Delays after the 1st, 2nd, 3rd, and 4th failure. Later failures wait EARLY_BIND_STEADY_MS. */
export const EARLY_BIND_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
export const EARLY_BIND_STEADY_MS = 60_000;

export function earlyBindDelayMs(failuresSoFar: number): number {
  return failuresSoFar < EARLY_BIND_DELAYS_MS.length ? EARLY_BIND_DELAYS_MS[failuresSoFar]! : EARLY_BIND_STEADY_MS;
}

export interface EarlyBindOptions<T> {
  connect: () => Promise<T>;
  /** True once an event, or a previous attempt, already bound a client. */
  alreadyBound: () => boolean;
  onBound: (client: T) => void;
  /** Close a client this attempt connected but will not use. */
  discard?: (client: T) => void;
  /** One line per failure. The caller chooses the log prefix. */
  log: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

/** Keep connecting until bind works, something else binds first, or stop() runs. */
export function startEarlyBind<T>(options: EarlyBindOptions<T>): { stop: () => void } {
  let stopped = false;
  let timer: { clear: () => void } | null = null;
  let failures = 0;
  const setTimer =
    options.setTimer ??
    ((fn, ms) => {
      const id = setTimeout(fn, ms);
      const handle = id as unknown as { unref?: () => void };
      handle.unref?.();
      return { clear: () => clearTimeout(id) };
    });

  const schedule = () => {
    if (stopped || options.alreadyBound()) return;
    const ms = earlyBindDelayMs(failures);
    timer = setTimer(() => {
      timer = null;
      void attempt();
    }, ms);
  };

  const attempt = async () => {
    if (stopped || options.alreadyBound()) return;
    try {
      const client = await options.connect();
      if (stopped || options.alreadyBound()) {
        options.discard?.(client);
        return;
      }
      options.onBound(client);
    } catch (err) {
      if (stopped || options.alreadyBound()) return;
      const message = err instanceof Error ? err.message : String(err);
      options.log(message);
      schedule();
      failures += 1;
    }
  };

  void attempt();
  return {
    stop() {
      stopped = true;
      timer?.clear();
      timer = null;
    },
  };
}
