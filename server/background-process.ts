/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { t } from "../shared/i18n";
import { KanbanError } from "./errors";

export interface BackgroundProcess {
  pid: number;
  ppid: number;
  pgid: number;
  session: string;
  uid: number;
  started: string;
  state: string;
}

/** One bounded local snapshot per tick; no shell, command-line contents or signal delivery. */
function processOutput(): string {
  const session = process.platform === "darwin" ? "sess" : "sid";
  return execFileSync("/bin/ps", ["-axo", `pid=,ppid=,pgid=,${session}=,uid=,lstart=,stat=`], {
    encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
}

export function backgroundProcesses(readOutput = processOutput): BackgroundProcess[] {
  const output = readOutput();
  return output.trim().split("\n").map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([A-Za-z?][A-Za-z0-9<>+\-]*)$/);
    if (!match) throw new Error(t("background.error.processCheck"));
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), session: match[4],
      uid: Number(match[5]), started: match[6], state: match[7] };
  });
}

function live(row: BackgroundProcess): boolean { return !/^[ZX]/.test(row.state); }

/** Start and register the background process in the same shell invocation. */
export function authorizeBackgroundProcess(pid: number, callerPid: number, uid: number, rows: BackgroundProcess[]): BackgroundProcess {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const target = byPid.get(pid);
  const caller = byPid.get(callerPid);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !target || !live(target) || target.uid !== uid || !caller || caller.uid !== uid) {
    throw new KanbanError("invalid", t("background.error.pid"));
  }
  const visited = new Set<number>();
  let ancestor: BackgroundProcess | undefined = target;
  while (ancestor && ancestor.pid > 1 && !visited.has(ancestor.pid)) {
    if (ancestor.pid === callerPid && target.pid !== callerPid) return target;
    visited.add(ancestor.pid);
    ancestor = byPid.get(ancestor.ppid);
  }
  // Modern macOS may redact sess to 0. That does not prove a shared session.
  if (!/^0+$/.test(target.session) && target.session === caller.session && target.pid !== callerPid) return target;
  throw new KanbanError("invalid", t("background.error.pid"));
}

export function sameBackgroundProcess(original: BackgroundProcess, rows: BackgroundProcess[]): boolean {
  return rows.some(row => row.pid === original.pid && row.uid === original.uid && row.pgid === original.pgid
    && row.started === original.started && live(row));
}

export type BackgroundProcessStatus = "alive" | "exited" | "unknown";

/** A failed snapshot cannot prove that a tracked process has exited. */
export function backgroundProcessStatus(original: BackgroundProcess, readProcesses: () => BackgroundProcess[]): BackgroundProcessStatus {
  try { return sameBackgroundProcess(original, readProcesses()) ? "alive" : "exited"; }
  catch { return "unknown"; }
}
