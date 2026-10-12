/** Epoch ms from a daemon log `time` field. Paseo has used both an ISO string and a number. */
export function daemonLogTime(line: string): number | null {
  const quoted = /"time":"([^"]+)"/.exec(line);
  if (quoted) {
    const t = Date.parse(quoted[1]);
    return Number.isFinite(t) ? t : null;
  }
  const numeric = /"time":(\d{10,})/.exec(line);
  if (!numeric) return null;
  const n = Number(numeric[1]);
  if (!Number.isFinite(n)) return null;
  if (n > 1e12) return n;
  if (n > 1e9) return n * 1000;
  return null;
}

export interface CrashSignal {
  at: number;
  /** True for a level-60 line. A worker-crash line in the same second is the same incident. */
  fatal: boolean;
  message: string;
}

/** A level-60 line, or a line that says the worker crashed. Null for everything else. */
export function parseCrashSignal(line: string): CrashSignal | null {
  let fatal = false;
  let worker = line.includes("Worker crashed");
  let message = "";
  try {
    const obj = JSON.parse(line) as { level?: unknown; err?: { message?: unknown }; msg?: unknown };
    fatal = obj.level === 60 || obj.level === "60";
    if (typeof obj.msg === "string" && obj.msg.includes("Worker crashed")) worker = true;
    if (fatal && obj.err && typeof obj.err.message === "string") message = obj.err.message;
    else if ((fatal || worker) && typeof obj.msg === "string") message = obj.msg;
  } catch {
    fatal = /"level"\s*:\s*60(?!\d)/.test(line);
  }
  if (!fatal && !worker) return null;
  const at = daemonLogTime(line);
  if (at === null) return null;
  return { at, fatal, message: message.slice(0, 300) };
}
