/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { doctorReds } from "../server/doctor-board";
import { DOCTOR_REPORT_FILE } from "../server/doctor";
import { lastRejections } from "../server/review-hold";
import { createTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "doctor-board-"));
process.env.KANBAN_DATA_DIR = dir;
mkdirSync(dir, { recursive: true });

const finding = (over: Record<string, unknown>) => ({
  id: "f", severity: "red", check: "card", project: "demo_tasks", card: null, taskId: null, object: "x", symptom: "s", evidence: "e", suggestion: "bin/kanban doctor", ...over,
});

describe("doctor reds for the board", () => {
  it("returns nothing when no report exists", () => {
    assert.deepEqual(doctorReds(), []);
  });

  it("keeps only red findings and filters by project, never running a check", () => {
    const report = {
      at: "2026-10-02T00:00:00Z", durationMs: 1, timedOut: false, counts: { red: 3, yellow: 1, info: 0 }, alertedIds: [],
      findings: [
        finding({ id: "a", card: "XYZ_0001", taskId: 1 }),
        finding({ id: "b", project: "ex" }),
        finding({ id: "c", project: null, object: "/tmp/dir" }),
        finding({ id: "d", severity: "yellow" }),
      ],
    };
    writeFileSync(join(dir, DOCTOR_REPORT_FILE), JSON.stringify(report));
    assert.deepEqual(doctorReds().map((r) => r.id), ["a", "b", "c"]);
    assert.deepEqual(doctorReds("demo_tasks").map((r) => r.id), ["a", "c"]);
    assert.equal(doctorReds()[0]!.suggestion, "bin/kanban doctor");
  });

  it("survives a broken report file", () => {
    writeFileSync(join(dir, DOCTOR_REPORT_FILE), "{not json");
    assert.deepEqual(doctorReds(), []);
  });
});

describe("doctor reds with bad report data", () => {
  it("skips non-object, severity-less and field-less findings", () => {
    const report = { at: "x", findings: [null, "str", 5, finding({ id: "no-sev", severity: undefined }), finding({ id: "no-symptom", symptom: 3 }), finding({ id: "ok" })] };
    writeFileSync(join(dir, DOCTOR_REPORT_FILE), JSON.stringify(report));
    assert.deepEqual(doctorReds().map((r) => r.id), ["ok"]);
  });

  it("returns an empty list for a whole-file bad report", () => {
    writeFileSync(join(dir, DOCTOR_REPORT_FILE), JSON.stringify({ findings: "nope" }));
    assert.deepEqual(doctorReds(), []);
    writeFileSync(join(dir, DOCTOR_REPORT_FILE), "[[[");
    assert.deepEqual(doctorReds(), []);
  });
});

describe("last rejections", () => {
  it("returns the last two request_changes in full, oldest first", () => {
    const task = createTask({ project: "demo_tasks", title: "t", role: "executor", brief: "b", workspacePath: dir, workspaceKind: "dir" } as never);
    const add = (kind: string, at: string, data: object) =>
      getDb().prepare(`INSERT INTO events (task_id, at, kind, data_json) VALUES (?, ?, ?, ?)`).run(task.id, at, kind, JSON.stringify(data));
    add("request_changes", "2026-10-01T01:00:00Z", { reason: "oldest", findings: "" });
    add("request_changes", "2026-10-01T02:00:00Z", { reason: "first long reason\nline two", findings: "F1" });
    add("claim", "2026-10-01T02:30:00Z", {});
    add("request_changes", "2026-10-01T03:00:00Z", { reason: "second", findings: "" });
    const rounds = lastRejections(task.id, 2);
    assert.deepEqual(rounds.map((r) => r.reason), ["first long reason\nline two", "second"]);
    assert.equal(rounds[0]!.findings, "F1");
  });

  it("prefers the rounds stored on review_leader_hold, keeping a leader rejected as round 1", () => {
    const task = createTask({ project: "demo_tasks", title: "t2", role: "executor", brief: "b", workspacePath: dir, workspaceKind: "dir" } as never);
    const add = (kind: string, at: string, data: object) =>
      getDb().prepare(`INSERT INTO events (task_id, at, kind, data_json) VALUES (?, ?, ?, ?)`).run(task.id, at, kind, JSON.stringify(data));
    add("request_changes", "2026-10-01T01:00:00Z", { reason: "old request", findings: "" });
    add("rejected", "2026-10-01T02:00:00Z", { reason: "leader said no", findings: "" });
    add("request_changes", "2026-10-01T03:00:00Z", { reason: "review no", findings: "F" });
    add("review_leader_hold", "2026-10-01T03:00:01Z", {
      rounds: [
        { reviewRound: 1, kind: "rejected", reason: "leader said no", findings: "" },
        { reviewRound: 2, kind: "request_changes", reason: "review no", findings: "F" },
      ],
    });
    const rounds = lastRejections(task.id, 2);
    assert.deepEqual(rounds.map((r) => [r.kind, r.reason]), [["rejected", "leader said no"], ["request_changes", "review no"]]);
    assert.equal(rounds[1]!.findings, "F");
  });

  it("drops an empty first round from the stored rounds", () => {
    const task = createTask({ project: "demo_tasks", title: "t3", role: "executor", brief: "b", workspacePath: dir, workspaceKind: "dir" } as never);
    getDb().prepare(`INSERT INTO events (task_id, at, kind, data_json) VALUES (?, ?, ?, ?)`).run(task.id, "2026-10-01T03:00:01Z", "review_leader_hold", JSON.stringify({
      rounds: [{ reviewRound: 1, kind: "request_changes", reason: "", findings: "" }, { reviewRound: 2, kind: "request_changes", reason: "only one", findings: "" }],
    }));
    assert.deepEqual(lastRejections(task.id, 2).map((r) => r.reason), ["only one"]);
  });
});

after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });
