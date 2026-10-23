import { execFileSync } from "node:child_process";

/** Read command arguments for the fixture processes whose liveness is being checked. */
export function processArguments(pids: number[], run = execFileSync): string[] {
  // The live sentinel makes ps succeed even when every tracked fixture has exited.
  const selected = [...new Set([...pids, process.pid])];
  return run("/bin/ps", ["-p", selected.join(","), "-o", "pid=,args="], {
    encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024 * 1024,
  }).split("\n");
}
