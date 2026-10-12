/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { setAgentAliveCheck, resetAgentAliveCheck } from "../server/alive";
import { setWakeSender } from "../server/bus";
import { cardMark } from "../server/card-ref";
import { doctorSettings, loadConfig, saveConfig } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { formatDoctor, runDoctor } from "../server/doctor";
import { createTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "doctor-decisions-"));
const decisionsPath = join(dir, "decisions.json");
process.env.KANBAN_DATA_DIR = dir;
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });
const now = new Date("2026-10-02T00:00:00Z");
const old = new Date(now.getTime() - 72 * 3_600_000).toISOString();
const messages: string[] = [];

function task(status: "acceptance" | "blocked", kind = "needs_human") {
  const card = createTask({ project: "doctor", title: status, role: "executor", workspacePath: dir });
  getDb().prepare("UPDATE tasks SET status = ?, blocked_kind = ?, blocked_at = ?, updated_at = ? WHERE id = ?")
    .run(status, kind, old, old, card.id);
  return { ...card, code: cardMark(card.id), findingId: `card:${status}:${card.id}` };
}

function decision(code: string, over: Record<string, unknown> = {}) {
  return { id: "decision-1", project: "doctor", title: `${zhCNPart("missingCwd.none", 0, 1)}${code}${zhCNPart("missingCwd.none", 3, 4)}Release scope`, detail: "A Release;B Sample text。Sample textA",
    blocking: false, status: "open", createdAt: old, ...over };
}

function write(rows: unknown) { writeFileSync(decisionsPath, JSON.stringify(rows)); }

async function diagnose(path = decisionsPath) {
  return runDoctor({ now, settings: doctorSettings(null), sources: {}, wake: true, persist: true, decisionsPath: path });
}

beforeEach(() => {
  getDb().exec("DELETE FROM start_claims; DELETE FROM events; DELETE FROM runs; DELETE FROM comments; DELETE FROM links; DELETE FROM tokens; DELETE FROM tasks;");
  rmSync(join(dir, "doctor-report.json"), { force: true });
  saveConfig({ ...loadConfig(), supervisorAgentId: "doctor-leader" });
  setAgentAliveCheck(() => true);
  messages.length = 0;
  setWakeSender((_id, text) => { messages.push(text); });
  write([]);
});

after(() => {
  setWakeSender(() => {});
  resetAgentAliveCheck();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("doctor timeout decisions", () => {
  for (const status of ["acceptance", "blocked"] as const) {
    it(`reports ${status} with an open decision as info without waking, then wakes when it closes`, async () => {
      const card = task(status);
      write([decision(card.code.toLowerCase(), { title: "Release scope", detail: `${zhCNPart("missingCwd.none", 0, 1)}${card.code.toLowerCase()}${zhCNPart("missingCwd.none", 3, 4)}${zhCNPart("doctor.ambiguous.evidence", 30, 32)}A` })]);
      const bytes = readFileSync(decisionsPath, "utf8");
      const first = await diagnose();
      const finding = first.findings.find((item) => item.id === card.findingId)!;
      assert.equal(finding.severity, "info");
      assert.equal(finding.symptom, zhCN("doctor.decision.symptom", {"ids":"decision-1"}));
      assert.match(finding.evidence, new RegExp(localePattern(zhCNPart("doctor.acceptance.symptom", 3, 6))));
      assert.match(formatDoctor(first), new RegExp(zhCN("doctor.decision.symptom", {"ids":"decision-1"})));
      assert.deepEqual(first.alertedIds, []);
      assert.equal(messages.length, 0);
      assert.equal(readFileSync(decisionsPath, "utf8"), bytes);

      write([decision(card.code, { status: "done" })]);
      const closed = await diagnose();
      assert.equal(closed.findings.find((item) => item.id === card.findingId)?.severity, "red");
      assert.deepEqual(closed.alertedIds, [card.findingId]);
      assert.equal(messages.length, 1);
      assert.ok(messages[0].includes(card.code));
      await diagnose();
      assert.equal(messages.length, 1);

      // A newly opened decision must clear an already delivered timeout alert.
      write([decision(card.code)]);
      assert.deepEqual((await diagnose()).alertedIds, []);
      assert.equal(messages.length, 1);
      write([]);
      assert.deepEqual((await diagnose()).alertedIds, [card.findingId]);
      assert.equal(messages.length, 2);
    });
  }

  it("uses the same exact-code boundaries and blocking-first ordering as the board", async () => {
    const card = task("acceptance");
    write([decision(card.code, { title: `${card.code}0 X${card.code} ${card.code}_suffix`, detail: "" })]);
    assert.equal((await diagnose()).findings.find((item) => item.id === card.findingId)?.severity, "red");
    assert.equal(messages.length, 1);
    write([decision(card.code), decision(card.code, { id: "blocking", blocking: true })]);
    const finding = (await diagnose()).findings.find((item) => item.id === card.findingId)!;
    assert.equal(finding.symptom, zhCN("doctor.decision.symptom", {"ids":"blocking、decision-1"}));
    assert.equal(messages.length, 1);
  });

  it("downgrades all overdue blocked kinds while leaving unrelated cards under the original rules", async () => {
    const cards = ["needs_human", "capability", "transient", "dependency", "quota", "rate_limit"]
      .map((kind) => task("blocked", kind));
    const unrelated = task("acceptance");
    write(cards.map((card, i) => decision(card.code, { id: `d-${i}` })));
    const report = await diagnose();
    for (const card of cards) assert.equal(report.findings.find((item) => item.id === card.findingId)?.severity, "info");
    assert.equal(report.findings.find((item) => item.id === unrelated.findingId)?.severity, "red");
    assert.deepEqual(report.alertedIds, [unrelated.findingId]);
    assert.equal(messages.length, 1);
    for (const card of cards) assert.ok(!messages[0].includes(card.code));
  });

  for (const failure of ["missing", "directory", "broken JSON", "invalid open row"] as const) {
    it(`restores alerts when the decisions source is ${failure}`, async () => {
      const cards = [task("acceptance"), task("blocked")];
      write(cards.map((card, i) => decision(card.code, { id: `d-${i}` })));
      await diagnose();
      assert.equal(messages.length, 0);
      let path = decisionsPath;
      if (failure === "missing") path = join(dir, "missing.json");
      if (failure === "directory") path = dir;
      if (failure === "broken JSON") writeFileSync(decisionsPath, "{broken");
      if (failure === "invalid open row") write([decision(cards[0].code), { status: "open" }]);
      const report = await diagnose(path);
      for (const card of cards) {
        assert.equal(report.findings.find((item) => item.id === card.findingId)?.severity, "red");
        assert.ok(report.alertedIds.includes(card.findingId));
      }
      assert.equal(messages.length, 1);
    });
  }
});
