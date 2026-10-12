/// <reference types="node" />
// Step timings for the panel RPCs. A round that runs past SLOW_ROUND_MS logs its slowest steps,
// so a slow panel can be traced from the daemon log without a debugger.

export const SLOW_ROUND_MS = 1_500;
const SLOWEST_SHOWN = 6;

export interface StepTimer {
  /** Await `work` and record how long it took under `label`. */
  step<T>(label: string, work: () => Promise<T> | T): Promise<T>;
  /** Recorded steps, slowest first. */
  steps(): ReadonlyArray<{ label: string; ms: number }>;
  totalMs(): number;
}

export function createStepTimer(now: () => number = () => performance.now()): StepTimer {
  const started = now();
  const marks: Array<{ label: string; ms: number }> = [];
  return {
    async step(label, work) {
      const t0 = now();
      try {
        return await work();
      } finally {
        marks.push({ label, ms: Math.round(now() - t0) });
      }
    },
    steps: () => [...marks].sort((a, b) => b.ms - a.ms),
    totalMs: () => Math.round(now() - started),
  };
}

/** One line for the log: total and the slowest steps. */
export function describeTimer(name: string, timer: StepTimer): string {
  const top = timer.steps().slice(0, SLOWEST_SHOWN).map((s) => `${s.label}=${s.ms}`).join(" ");
  return `[afc] ${name} ${timer.totalMs()}ms: ${top}`;
}

export function logIfSlow(name: string, timer: StepTimer, limitMs = SLOW_ROUND_MS): void {
  if (timer.totalMs() >= limitMs) console.log(describeTimer(name, timer));
}
