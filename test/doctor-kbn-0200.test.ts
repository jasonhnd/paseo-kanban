/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { doctorSettings, type DoctorSettings } from "../server/config";
import { closeDb, getDb } from "../server/db";
import { clearDoctorSafetyCache, doctorReportPath, doctorReportSidecar, readLastDoctorReport, runDoctor, type DoctorGit } from "../server/doctor";
import { createTask } from "../server/store";

const tmp = realpathSync(tmpdir());
const dir = mkdtempSync(join(tmp, "doctor-test-0200-"));
process.env.KANBAN_DATA_DIR = dir;

const NOW = new Date("2026-10-01T03:00:00.000Z");
const ROOT = join(dir, "worktrees");
const REPO = join(dir, "repo");
const settings: DoctorSettings = { ...doctorSettings(null), totalTimeoutMs: 5_000, commandTimeoutMs: 1_000 };

function git(over: Partial<DoctorGit> = {}): DoctorGit {
  return {
    repos: [REPO],
    async worktrees() {
      return [];
    },
    async dirty() {
      return false;
    },
    async branches() {
      return [];
    },
    async pushed() {
      return true;
    },
    async pr() {
      return "none";
    },
    async tip() {
      return "abc";
    },
    ...over,
  };
}

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("doctor TEST_0200", () => {
  it("writes the report by rename so a reader never sees a partial file or a leftover temp", async () => {
    const first = doctorReportSidecar();
    const second = doctorReportSidecar();
    assert.notEqual(first, second);
    assert.match(first, new RegExp(`doctor-report\\.json\\.${process.pid}\\.\\d+\\.[0-9a-f]+\\.tmp$`));
    const report = await runDoctor({ now: NOW, settings, sources: {}, persist: true });
    const raw = readFileSync(doctorReportPath(), "utf8");
    assert.deepEqual(JSON.parse(raw), report);
    assert.equal(readLastDoctorReport()?.at, report.at);
    assert.equal(readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
  });

  it("keeps a lane worktree quiet while another doctor finishes and drops its scan", async () => {
    const laneDir = join(ROOT, "remembered-lane");
    const task = createTask({ project: "doctor", title: "lane", role: "executor", workspacePath: REPO });
    getDb()
      .prepare("INSERT INTO events (task_id, at, kind, to_status, actor, data_json) VALUES (?, ?, 'lane_bound', NULL, 'test', ?)")
      .run(task.id, NOW.toISOString(), JSON.stringify({ workspaceId: "lane-ws", directory: laneDir }));
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened: () => void = () => {};
    const open = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const slow = runDoctor({
      now: NOW,
      settings,
      sources: {
        git: git({
          async worktrees() {
            opened();
            await held;
            return [{ path: laneDir, branch: "topic" }];
          },
        }),
      },
    });
    await open;
    await runDoctor({ now: NOW, settings, sources: { git: git() } });
    release();
    const report = await slow;
    assert.equal(report.findings.some((item) => item.check === "worktree" && item.object === laneDir), false);
  });

  it("reuses git and gh safety results for an orphan worktree for 30 minutes", async () => {
    clearDoctorSafetyCache();
    const stray = join(ROOT, "stray-wt");
    let probes = 0;
    const sources = {
      git: git({
        async worktrees() {
          return [{ path: stray, branch: "topic" }];
        },
        async dirty() {
          probes += 1;
          return false;
        },
        async pushed() {
          probes += 1;
          return true;
        },
        async pr() {
          probes += 1;
          return "none" as const;
        },
        async tip() {
          probes += 1;
          return "abc123";
        },
      }),
    };
    const first = await runDoctor({ now: NOW, settings, sources });
    assert.match(first.findings.find((item) => item.object === stray)?.suggestion ?? "", new RegExp(zhCN("doctor.safety.unsafe") + "|" + zhCN("doctor.safety.safe") + "|unknown"));
    const afterFirst = probes;
    assert.ok(afterFirst >= 4);
    const second = await runDoctor({ now: new Date(NOW.getTime() + 29 * 60_000), settings, sources });
    assert.equal(probes, afterFirst);
    assert.equal(second.findings.find((item) => item.object === stray)?.suggestion, first.findings.find((item) => item.object === stray)?.suggestion);
    await runDoctor({ now: new Date(NOW.getTime() + 31 * 60_000), settings, sources });
    assert.ok(probes > afterFirst);
  });

  it("matches live api agents with a map instead of a scan per row", () => {
    const text = readFileSync(new URL("../server/doctor-live.ts", import.meta.url), "utf8");
    const start = text.indexOf("function mergeAgents");
    const end = text.indexOf("function unreadableBoard");
    const body = text.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(body, /new Map/);
    assert.doesNotMatch(body, /\.find\(/);
  });
});
