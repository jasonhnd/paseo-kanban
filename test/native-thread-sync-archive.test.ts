import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { nativeSessionsCommand } from "../server/native-sessions";
import { nativeReconcileFixture } from "./helpers/native-reconcile-fixture";

// The public plugin reconciles board metadata. The archived desktop sync tool
// is outside its supported surface and must not be imported into the package.
let fixture: ReturnType<typeof nativeReconcileFixture>;
beforeEach(() => { fixture = nativeReconcileFixture(); });
afterEach(() => fixture.cleanup());

it("reconciles an already archived Claude session without modifying desktop cards or archive bytes", async () => {
  const { home, env, queue, status } = fixture;
  const agent = queue("claude", "archived-session");
  const archive = join(home, ".claude/projects-archive/-work-demo");
  mkdirSync(archive, { recursive: true });
  const transcript = join(archive, "archived-session.jsonl");
  writeFileSync(transcript, "opaque archive bytes\n", { mode: 0o600 });
  const desktop = join(home, "Library/Application Support/Claude");
  mkdirSync(desktop, { recursive: true });
  const card = join(desktop, "card.json");
  writeFileSync(card, JSON.stringify({ isArchived: false, title: "User card" }));
  const before = [readFileSync(transcript), readFileSync(card)];
  const dry = await nativeSessionsCommand({ reconcileClaude: true }, env, { home });
  assert.ok("lines" in dry); assert.equal(dry.lines.length, 1);
  assert.equal(status(agent), "pending");
  await nativeSessionsCommand({ reconcileClaude: true, apply: true }, env, { home });
  assert.equal(status(agent), "archived");
  const again = await nativeSessionsCommand({ reconcileClaude: true, apply: true }, env, { home });
  assert.ok("lines" in again); assert.equal(again.lines.length, 0);
  assert.deepEqual([readFileSync(transcript), readFileSync(card)], before);
});

it("keeps live sessions and ambiguous archives pending", async () => {
  const { home, env, queue, status } = fixture;
  const live = queue("claude", "live-session");
  const ambiguous = queue("claude", "ambiguous-session");
  const source = join(home, ".claude/projects/-work-demo");
  const archive = join(home, ".claude/projects-archive/-work-demo");
  mkdirSync(source, { recursive: true }); mkdirSync(archive, { recursive: true });
  writeFileSync(join(source, "live-session.jsonl"), "live bytes");
  for (const name of ["live-session.jsonl", "ambiguous-session.one.jsonl", "ambiguous-session.two.jsonl"]) writeFileSync(join(archive, name), "archive bytes");
  const result = await nativeSessionsCommand({ reconcileClaude: true, apply: true }, env, { home });
  assert.ok("lines" in result); assert.equal(result.lines.length, 0);
  assert.equal(status(live), "pending"); assert.equal(status(ambiguous), "pending");
});
