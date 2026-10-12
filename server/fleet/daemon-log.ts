/// <reference types="node" />
import { daemonLogTime } from "../../shared/fleet/daemon-log";

export { type CrashSignal, daemonLogTime, parseCrashSignal } from "../../shared/fleet/daemon-log";

/** Timestamps of "Starting daemon worker" lines. Unrecognized lines are skipped. */
export function parseDaemonRestartTimes(text: string): number[] {
  const times: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("Starting daemon worker")) continue;
    const t = daemonLogTime(line);
    if (t !== null) times.push(t);
  }
  return times;
}

/** First `"daemonVersion":"..."` in a log blob, if the field is still there. */
export function parseDaemonVersion(text: string): string | null {
  const m = /"daemonVersion":"([^"]+)"/.exec(text);
  return m?.[1] ?? null;
}
