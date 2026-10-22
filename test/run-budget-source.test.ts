import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { interruptRunBudgetAgent, readRunBudgetObservation } from "../server/run-budget-source";

mkdirSync(tmpdir(), { recursive: true });
const root = mkdtempSync(join(tmpdir(), "run-source-"));
after(() => rmSync(root, { recursive: true, force: true }));
const session = ["10000000", "0000", "4000", "8000", "000000000001"].join("-");
const usage = { timestamp: "2026-10-01T11:30:00Z", type: "event_msg", payload: { type: "token_count", info: {
  total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50 },
  last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50 },
} } };
function fakeApi(agent: unknown, page?: unknown): PaseoApi {
  return { agents: { ref: () => ({ refresh: async () => ({ agent }), current: () => agent,
    timeline: { refetch: async () => page ?? { agentId: "fixture", projection: "canonical", error: null, gap: false, staleCursor: false, hasNewer: false, hasOlder: false,
      window: { minSeq: 1 }, entries: [{ seqStart: 1, seqEnd: 1, timestamp: "2026-10-01T11:31:00Z", item: { type: "assistant_message", text: "Done" } }] } },
  }) } } as unknown as PaseoApi;
}

it("reads only the matching Codex session and exposes cache reads separately", async () => {
  const home = join(root, "codex"); const dir = join(home, "sessions", "2026", "10", "01"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-fixture-${session}.jsonl`), `${JSON.stringify(usage)}\n`);
  const old = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  try {
    const result = await readRunBudgetObservation(fakeApi({ provider: "codex", persistence: { nativeHandle: session } }), "fixture");
    assert.equal(result.source, "codex-token-count"); assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].cachedInputTokens, 50);
  } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; }
});
it("bounds large transcript reads and declares the retained tail partial", async () => {
  const home = join(root, "large"); const dir = join(home, "sessions", "2026", "10", "01"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-fixture-${session}.jsonl`), `${" ".repeat(9 * 1024 * 1024)}\n${JSON.stringify(usage)}\n`);
  const old = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  try {
    const result = await readRunBudgetObservation(fakeApi({ provider: "codex", persistence: { nativeHandle: session } }), "fixture");
    assert.equal(result.source, "codex-token-count"); assert.equal(result.complete, false);
    assert.match(result.notes.join(" "), /lower bound/);
  } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; }
});
it("falls back safely for an unavailable session and rejects a gapped canonical timeline", async () => {
  const result = await readRunBudgetObservation(fakeApi({ provider: "codex", persistence: { nativeHandle: "invalid/session" } }), "fixture");
  assert.equal(result.source, "canonical-rounds");
  assert.match(result.notes.join(" "), /unavailable/);
  await assert.rejects(readRunBudgetObservation(fakeApi({}, { agentId: "fixture", projection: "canonical", gap: true }), "fixture"), /inconsistent/);
});
it("stops exactly one agent using the selected endpoint without archiving or sending a prompt", async () => {
  const bin = join(root, "bin"); mkdirSync(bin); const receipt = join(root, "stop.json");
  const executable = join(bin, "paseo");
  writeFileSync(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(executable, 0o700);
  const oldPath = process.env.PATH; const oldUrl = process.env.PASEO_URL;
  process.env.PATH = bin; process.env.PASEO_URL = "ws://127.0.0.1:1";
  try {
    await interruptRunBudgetAgent("fixture-agent");
    assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), ["agent", "stop", "fixture-agent", "--host", "ws://127.0.0.1:1", "--json"]);
    await assert.rejects(interruptRunBudgetAgent("--all"), /Invalid agent id/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldUrl === undefined) delete process.env.PASEO_URL; else process.env.PASEO_URL = oldUrl;
  }
});
