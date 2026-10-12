/// <reference types="node" />
// An independent scheduler with its own SQLite connection and a fixture-only launcher.
import { closeDb, getDb } from "../../server/db";
import { loadConfig } from "../../server/config";
import { openEntry } from "../../server/pools";
import { runTick } from "./compat-schedule";
import { getTask } from "../../server/store";
import type { Profile } from "../../server/profiles";
import { setGhRunner } from "../../server/pr";

// A done PR parent may be polled by ordinary cleanup; keep that existing path local too.
setGhRunner(async () => JSON.stringify({ state: "OPEN", mergedAt: null }));

const id = Number(process.argv[2]);
const profiles: Profile[] = [
  { id: "ex", name: "Executor", role: "executor", family: "xai", provider: "cursor", model: "grok-4.7", pool: "cursor" },
  { id: "rv", name: "Reviewer", role: "reviewer", family: "anthropic", provider: "claude", model: "sonnet", pool: "claude-max" },
];
let created = 0;
let stopped = false;
getDb();
process.send?.({ kind: "ready" });
process.on("message", async (mode: string) => {
  if (mode === "stop") { stopped = true; return; }
  try {
    do {
      const before = getTask(id);
      const result = await runTick({
        config: loadConfig(), profiles, matrix: { state: "missing" },
        pools: { state: "fresh", generatedAt: new Date().toISOString(), updatedAt: null, ageMs: 0, message: "fixture",
          dispatchable: () => true, entry: () => ({ ...openEntry(), dispatchable: true }) },
        launcher: { async create() { created++; return { id: "fixture-only-scheduler" }; }, async send() {} },
        agentState: () => "alive",
      });
      const after = getTask(id);
      process.send?.({ kind: "tick", created, started: result.started,
        before: { status: before.status, decision: before.wait_decision },
        after: { status: after.status, decision: after.wait_decision } });
      if (mode !== "loop") break;
      await new Promise<void>(resolve => setImmediate(resolve));
    } while (!stopped);
    if (stopped) { closeDb(); process.disconnect(); }
  } catch (error) {
    process.send?.({ kind: "error", message: String(error) });
    closeDb(); process.disconnect(); process.exitCode = 1;
  }
});
