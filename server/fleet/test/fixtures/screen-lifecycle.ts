/// <reference types="node" />
// A subprocess deliberately fails, times out, cancels, or loses its test worker.
import { writeFileSync } from "node:fs";
import test from "node:test";
import { terminal, until } from "../screen-fixture";

const mode = process.env.DEMO_LIFECYCLE;
const record = process.env.DEMO_LIFECYCLE_RECORD!;
const controller = new AbortController();

test("interrupted terminal owner", { timeout: mode === "timeout" ? 1_500 : 20_000, signal: controller.signal }, async (t) => {
  const f = terminal(t, "timeout", undefined, undefined, {
    DEMO_PID_FILE: `${record}.pids`, DEMO_TERM_FILE: `${record}.terms`, DEMO_START_DELAY_MS: "2500",
  });
  writeFileSync(record, JSON.stringify({ dir: f.dir, sockets: f.sockets, session: f.sessionName }));
  const opening = f.open();
  void opening.catch(() => {});
  if (mode === "killed") {
    await opening;
    process.kill(process.pid, "SIGKILL");
    return;
  }
  await until(() => f.pids().length > 0, "the detached fixture has started");
  if (mode === "failure") throw new Error("Synthetic assertion failure during startup");
  if (mode === "cancel") controller.abort(new Error("Synthetic test cancellation"));
  if (mode === "timeout") await new Promise<void>((resolve) => {
    if (t.signal.aborted) resolve();
    else t.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await opening;
});
