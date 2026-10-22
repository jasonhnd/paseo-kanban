import { spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";

export interface CloudCommandOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface CloudCommandResult { code: number; stdout: string; stderr: string }
export type CloudCommand = (command: string, args: string[], options: CloudCommandOptions) => Promise<CloudCommandResult>;

/** No shell interpolation. Abort and timeout terminate the complete local CLI process group. */
export const executeCloudCommand: CloudCommand = (command, args, options) => new Promise(resolve => {
  if (options.signal?.aborted) { resolve({ code: 130, stdout: "", stderr: "aborted" }); return; }
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let bytes = 0; let stopped: number | null = null;
  let force: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already exited */ }
  };
  const stop = (code: number) => {
    if (stopped != null) return;
    stopped = code; kill("SIGTERM");
    force = setTimeout(() => kill("SIGKILL"), 250);
  };
  const abort = () => stop(130);
  const timer = setTimeout(() => stop(124), options.timeoutMs ?? 30_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const collect = (value: Buffer, error: boolean) => {
    bytes += value.length;
    if (bytes > 64 * 1024 * 1024) { stop(125); return; }
    if (error) stderr += value.toString("utf8"); else stdout += value.toString("utf8");
  };
  child.stdout.on("data", value => collect(value, false));
  child.stderr.on("data", value => collect(value, true));
  child.on("error", () => { stderr = "command unavailable"; });
  child.on("close", code => {
    clearTimeout(timer); if (force) clearTimeout(force);
    // A CLI may exit before its descendants close. Kill remaining members on cancellation too.
    if (stopped != null) kill("SIGKILL");
    options.signal?.removeEventListener("abort", abort);
    resolve({ code: stopped ?? code ?? 1, stdout, stderr });
  });
});
