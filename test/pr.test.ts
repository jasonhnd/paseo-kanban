/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { closeDb, getDb } from "../server/db";
import { KanbanError } from "../server/errors";
import { approveTask, completeTask, pollAwaitingPr } from "../server/flow";
import { assertReadOnly, evaluateContract, parsePrUrl, readContract, resetCheckCache, setGhRunner, type GhRunner } from "../server/pr";
import { claimStatus, createTask, getTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "TEST_0124-pr-"));
process.env.KANBAN_DATA_DIR = dir;

const pr = "https://github.com/acme/widgets/pull/7";
const sha = "abc123";
const checkout = join(dir, "checkout");
mkdirSync(checkout);
execFileSync("git", ["init", "--quiet", checkout]);
execFileSync("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/acme/widgets.git"]);

function submit(handoff: unknown, summary = "Handoff", workspacePath = checkout, project = "pr"): number {
  const task = createTask({ project, title: "PR Sample text", role: "executor", workspacePath });
  claimStatus(task.id, "ready", "running", "test");
  completeTask(task.id, "executor", summary, handoff);
  return task.id;
}

function boundPr(id: number): unknown {
  return JSON.parse(getTask(id).contract_json!).pr;
}

function completeEvent(id: number): { ignoredPr?: Array<{ url: string; reason: string }>; prCandidates?: string[] } {
  const row = getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'complete' ORDER BY id DESC LIMIT 1").get(id) as { data_json: string };
  return JSON.parse(row.data_json);
}

function gh(mode: "pass" | "wait" | "fail" | "error"): GhRunner {
  return async (args) => {
    if (mode === "error") throw new Error("gh: authentication required");
    const line = args.join(" ");
    if (line.startsWith("pr view")) return JSON.stringify({ url: pr, headRefOid: sha, headRefName: "feature" });
    if (line.includes("/protection")) return JSON.stringify({ required_status_checks: { contexts: ["ci"] } });
    if (line.includes("/rules/")) {
      return JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }]);
    }
    if (line.includes("/statuses")) return "[]";
    if (line.includes("check-runs")) {
      const status = mode === "wait" ? "in_progress" : "completed";
      const conclusion = mode === "pass" ? "success" : mode === "wait" ? null : "failure";
      return JSON.stringify({
        check_runs: [{ name: "ci", status, conclusion, html_url: "https://github.com/acme/widgets/runs/1" }],
      });
    }
    throw new Error(line);
  };
}

function reviewing(title: string): number {
  const task = createTask({ project: "pr", title, role: "executor", contract: "github:acme/widgets", workspacePath: dir });
  claimStatus(task.id, "ready", "running", "test");
  completeTask(task.id, "executor", "Handoff", { pr, files: ["README.md"] });
  getDb().prepare("UPDATE tasks SET status = 'reviewing', executor_agent_id = 'exec-1', agent_id = 'rev-1' WHERE id = ?").run(task.id);
  return task.id;
}

after(() => {
  setGhRunner(null);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("pull request contract", () => {
  it("accepts an executor waitingOn handoff while CI runs and still gates review approval", async () => {
    setGhRunner(gh("wait"));
    const task = createTask({ project: "pr", title: "Sample text CI Complete normally", role: "executor", contract: "github:acme/widgets", workspacePath: dir });
    claimStatus(task.id, "ready", "running", "test");
    const handoff = { pr, files: [], verification: "local passed", risks: [], waitingOn: "CI" };
    assert.equal(completeTask(task.id, "executor", (zhCNPart("compactEvents.apply.text", 6, 8) + zhCNPart("panelPrefs.brokenNoBackup", 1, 2)), handoff).status, "in_review");
    getDb().prepare("UPDATE tasks SET status = 'reviewing' WHERE id = ?").run(task.id);
    assert.equal((await approveTask(task.id, (zhCNPart("tempLand.conflict.withCard", 20, 22) + zhCNPart("cardDrawer.verdict.approve", 2, 4)))).status, "reviewing");
    assert.equal(JSON.parse(getTask(task.id).handoff_json!).handoff.waitingOn, "CI");
    setGhRunner(gh("pass"));
    assert.equal((await approveTask(task.id, "CI Green")).status, "acceptance");
  });

  it("records a pull request url buried in a local-only handoff or summary", () => {
    const task = createTask({ project: "pr", title: "demo fixture Demo text", role: "executor", workspacePath: checkout });
    claimStatus(task.id, "ready", "running", "test");
    const handoff = JSON.stringify({
      files: ["docs/requirements/f2/EVIDENCE.md"],
      verification: ["PR https://github.com/acme/widgets/pull/156 base=dev"],
      pr: 156,
    });
    completeTask(task.id, "executor", ("PR #156" + zhCN("common.colon") + "Demo text"), handoff);
    assert.match(getTask(task.id).contract_json ?? "", /acme\/widgets\/pull\/156/);

    const summaryOnly = createTask({ project: "pr", title: "demo fixture Demo text", role: "executor", workspacePath: checkout });
    claimStatus(summaryOnly.id, "ready", "running", "test");
    completeTask(summaryOnly.id, "executor", "Delivery https://github.com/acme/widgets/pull/44", { files: ["README.md"] });
    assert.match(getTask(summaryOnly.id).contract_json ?? "", /acme\/widgets\/pull\/44/);
  });

  it("ignores foreign PRs in handoff and summary, leaving no merge dependency", () => {
    const foreign = "https://github.com/other/project/pull/264";
    const id = submit({ verification: `Evidence ${foreign}` }, `${zhCNPart("flow.error.noSummary", 0, 2)} ${foreign}`);
    assert.equal(boundPr(id), null);
    assert.deepEqual(completeEvent(id).ignoredPr, [{ url: foreign, reason: "repository_mismatch: expected acme/widgets" }]);
  });

  it("never binds prose or explicit PRs when a local checkout has no origin", () => {
    const local = join(dir, "no-origin");
    mkdirSync(local);
    execFileSync("git", ["init", "--quiet", local]);
    for (const handoff of [{ verification: pr }, { pr }, JSON.stringify({ pr })]) {
      const id = submit(handoff, "Handoff", local);
      assert.equal(boundPr(id), null);
      assert.deepEqual(completeEvent(id).ignoredPr, [{ url: pr, reason: "project_repository_unknown_or_no_origin" }]);
    }
  });

  it("compares repository identities without case sensitivity", () => {
    const mixed = "https://GitHub.com/ACME/Widgets/pull/9";
    assert.equal(boundPr(submit({ pr: mixed })), mixed);
    const task = createTask({ project: "pr", title: "Contract case", role: "executor", contract: "github:ACME/Widgets" });
    claimStatus(task.id, "ready", "running", "test");
    completeTask(task.id, "executor", "Handoff", { pr });
    assert.equal(boundPr(task.id), pr);
  });

  it("ignores an explicit foreign PR without falling back to an incidental matching link", () => {
    const foreign = "https://github.com/other/project/pull/264";
    const id = submit(JSON.stringify({ pr: foreign, verification: pr }));
    assert.equal(boundPr(id), null);
    assert.match(completeEvent(id).ignoredPr![0]!.reason, /repository_mismatch/);
    assert.equal(completeEvent(id).ignoredPr![0]!.url, foreign);
  });

  it("chooses the last matching link, or the explicit handoff.pr, and records candidates", () => {
    const second = "https://github.com/acme/widgets/pull/8";
    const foreign = "https://github.com/other/project/pull/264";
    const id = submit({ verification: `${pr} then ${second} then ${foreign}` });
    assert.equal(boundPr(id), second);
    assert.deepEqual(completeEvent(id).prCandidates, [pr, second]);
    const explicit = submit(JSON.stringify({ pr, verification: second }), `Handoff ${second}`);
    assert.equal(boundPr(explicit), pr);
    assert.deepEqual(new Set(completeEvent(explicit).prCandidates), new Set([pr, second]));
    // Repeated links still count in text order: A, B, A selects A.
    assert.equal(boundPr(submit({ verification: `${pr} ${second} ${pr}` })), pr);
    assert.equal(boundPr(submit({ verification: pr }, `Handoff ${second}`)), second);
  });

  it("completes a bare PR number with the project repository", () => {
    for (const [handoff, summary] of [
      [{ files: [] }, ("PR #280 " + zhCNPart("flow.accept.noCommits", 0, 2) + zhCNPart("compactEvents.apply.pruned", 19, 22) + "dev" + zhCNPart("boardView.done.conflictWorkspace", 51, 55))],
      [{ verification: "PR#281 Updated" }, "Handoff"],
      [{ verification: "pull request #282 Conflict resolved" }, "Handoff"],
      [{ files: [] }, (zhCNPart("reclaimNote.branch.pushed", 1, 3) + zhCNPart("tempWorkspace.missingPr.error", 7, 11) + ": #283")],
    ] as const) {
      const id = submit(handoff, summary);
      const number = (summary + JSON.stringify(handoff)).match(/#(\d+)/)?.[1];
      assert.equal(boundPr(id), `https://github.com/acme/widgets/pull/${number}`);
    }
    const id = submit({ files: [] }, ("PR #280" + zhCN("common.comma") + "Demo text PR #281"));
    assert.equal(boundPr(id), "https://github.com/acme/widgets/pull/281");
    assert.deepEqual(completeEvent(id).prCandidates, [
      "https://github.com/acme/widgets/pull/280",
      "https://github.com/acme/widgets/pull/281",
    ]);
  });

  it("does not read issue numbers or an explicit handoff.pr as a bare PR", () => {
    assert.equal(boundPr(submit({ files: [] }, ("Fixed issue #280" + zhCN("common.comma") + zhCNPart("boardView.done.conflictBrief", 54, 56) + "#12"))), null);
    const explicit = submit({ pr, verification: "PR #280" });
    assert.equal(boundPr(explicit), pr);
  });

  it("lets a full link win over a bare number", () => {
    const second = "https://github.com/acme/widgets/pull/8";
    assert.equal(boundPr(submit({ verification: `${second}` }, "PR #280")), second);
  });

  it("does not bind a bare PR number when the repository is unknown, and records it", () => {
    const local = join(dir, "no-origin-bare");
    mkdirSync(local);
    execFileSync("git", ["init", "--quiet", local]);
    const id = submit({ files: [] }, ("PR #280 " + zhCNPart("flow.accept.noCommits", 0, 2) + zhCNPart("compactEvents.apply.pruned", 19, 22) + "dev"), local);
    assert.equal(boundPr(id), null);
    assert.deepEqual(completeEvent(id).ignoredPr, [{ url: "#280", reason: "project_repository_unknown_or_no_origin" }]);
  });

  it("records invalid explicit URLs rather than replacing them with incidental links", () => {
    const invalid = "https://example.com/acme/widgets/pull/7";
    const id = submit({ pr: invalid, verification: pr });
    assert.equal(boundPr(id), null);
    assert.deepEqual(completeEvent(id).ignoredPr, [{ url: invalid, reason: "invalid_pr_url" }]);
  });

  it("resolves configured project repositories and workspace paths, while no-origin stays local", () => {
    writeFileSync(join(dir, "kanban.config.json"), JSON.stringify({ projects: {
      configured: { repo: "ACME/widgets", workspacePath: checkout },
      configuredOnly: { repo: "acme/widgets" },
      configuredWorkspace: { workspacePath: `dir:${checkout}` },
      configuredLocal: { repo: "acme/widgets", workspacePath: join(dir, "no-origin") },
    } }));
    assert.equal(boundPr(submit({ pr }, "Handoff", dir, "configured")), pr);
    const task = createTask({ project: "configuredOnly", title: "Configuration repository", role: "executor" });
    claimStatus(task.id, "ready", "running", "test");
    completeTask(task.id, "executor", "Handoff", { pr });
    assert.equal(boundPr(task.id), pr);
    assert.equal(boundPr(submit({ pr }, "Handoff", dir, "configuredWorkspace")), pr);
    assert.equal(boundPr(submit({ pr }, "Handoff", checkout, "configuredLocal")), null);
  });

  it("also records ignored PRs on non-executor completion events", () => {
    const task = createTask({ project: "pr", title: "Read-only report evidence", role: "reader", workspacePath: checkout });
    claimStatus(task.id, "ready", "running", "test");
    completeTask(task.id, "reader", "Handoff", { pr: "https://github.com/other/project/pull/264" });
    assert.equal(getTask(task.id).status, "acceptance");
    assert.match(completeEvent(task.id).ignoredPr![0]!.reason, /repository_mismatch/);
  });

  it("binds the first PR and refuses a different one", () => {
    const task = createTask({ project: "pr", title: "demo fixture", role: "executor", contract: "github:acme/widgets" });
    claimStatus(task.id, "ready", "running", "test");
    assert.throws(() => completeTask(task.id, "executor", (zhCNPart("history.noMatch", 0, 2) + zhCNPart("boardView.done.prBrief", 7, 9)), {}), (err: unknown) => err instanceof KanbanError && err.code === "pr_required");
    const done = completeTask(task.id, "executor", "Handoff", { pr });
    assert.equal(done.status, "in_review");
    assert.match(getTask(task.id).contract_json ?? "", /acme\/widgets\/pull\/7/);
    getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
    assert.throws(
      () => completeTask(task.id, "executor", zhCNPart("cardRef.error.codeShown", 109, 112), { pr: "https://github.com/acme/widgets/pull/8" }),
      (err: unknown) => err instanceof KanbanError && err.code === "pr_bound",
    );
  });

  it("lets a card into acceptance only when required checks pass", async () => {
    setGhRunner(gh("pass"));
    const id = reviewing(zhCNPart("cardDrawer.verdict.approve", 2, 4));
    const next = await approveTask(id, zhCN("cardDrawer.verdict.approve"));
    assert.equal(next.status, "acceptance");
  });

  it("stays in review and shows why while required checks are still running", async () => {
    setGhRunner(gh("wait"));
    const id = reviewing(zhCNPart("cardParts.event.prWait", 0, 2));
    const next = await approveTask(id, zhCN("cardDrawer.verdict.approve"));
    assert.equal(next.status, "reviewing");
    assert.match(getTask(id).hold_reason ?? "", new RegExp(zhCN("reclaimNote.result.running")));
    assert.match(getTask(id).contract_json ?? "", /"awaiting":true/);
  });

  it("sends a failed required check back to the executor with the name and link", async () => {
    setGhRunner(gh("fail"));
    const id = reviewing(zhCN("compat.run.failed"));
    const next = await approveTask(id, zhCN("cardDrawer.verdict.approve"));
    assert.equal(next.status, "rework");
    assert.equal(next.agent_id, "exec-1");
    const comment = getDb().prepare("SELECT body FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(id) as { body: string };
    assert.match(comment.body, /ci/);
    assert.match(comment.body, /https:\/\/github.com\/acme\/widgets\/runs\/1/);
  });

  it("refuses completion when gh cannot be queried", async () => {
    setGhRunner(gh("error"));
    const id = reviewing(zhCNPart("cardParts.event.prError", 2, 6));
    await assert.rejects(async () => {
      await approveTask(id, zhCN("cardDrawer.verdict.approve"));
    }, (err: unknown) => err instanceof KanbanError && err.code === "pr_checks");
    const task = getTask(id);
    assert.equal(task.status, "reviewing");
    assert.match(task.hold_reason ?? "", new RegExp("gh " + localePattern(zhCNPart("cardParts.event.prError", 2, 6))));
  });

  it("does not let a non-executor github card into acceptance until required checks pass", async () => {
    const task = createTask({ project: "pr", title: "Local decision", role: "decision" });
    claimStatus(task.id, "ready", "running", "test");
    const local = completeTask(task.id, "decision", (zhCNPart("routing.profileBannedReason", 4, 7) + "PR"), null);
    assert.ok(!(local instanceof Promise));
    if (local instanceof Promise) return;
    assert.equal(local.status, "acceptance");

    setGhRunner(gh("pass"));
    const passed = createTask({ project: "pr", title: "Decision passed", role: "decision", contract: "github:acme/widgets" });
    claimStatus(passed.id, "ready", "running", "test");
    assert.equal((await completeTask(passed.id, "decision", "Handoff", { pr })).status, "acceptance");

    setGhRunner(gh("wait"));
    const waiting = createTask({ project: "pr", title: "Decision waiting", role: "reader", contract: "github:acme/widgets" });
    claimStatus(waiting.id, "ready", "running", "test");
    await assert.rejects(async () => {
      await completeTask(waiting.id, "reader", "Handoff", { pr });
    }, (err: unknown) => err instanceof KanbanError && err.code === "pr_checks");
    const held = getTask(waiting.id);
    assert.equal(held.status, "running");
    assert.match(held.hold_reason ?? "", new RegExp(zhCN("reclaimNote.result.running")));
    assert.match(held.contract_json ?? "", /"awaiting":true/);
    setGhRunner(gh("pass"));
    const moved = await pollAwaitingPr();
    assert.ok(moved.includes(waiting.id));
    assert.equal(getTask(waiting.id).status, "acceptance");

    setGhRunner(gh("fail"));
    const failed = createTask({ project: "pr", title: "Decision failed", role: "batch", contract: "github:acme/widgets" });
    claimStatus(failed.id, "ready", "running", "test");
    await assert.rejects(async () => {
      await completeTask(failed.id, "batch", "Handoff", { pr });
    }, (err: unknown) => err instanceof KanbanError && err.code === "pr_checks" && /https:\/\/github.com\/acme\/widgets\/runs\/1/.test(err.message));
    assert.equal(getTask(failed.id).status, "running");
    const comment = getDb().prepare("SELECT body FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(failed.id) as { body: string };
    assert.match(comment.body, /ci/);
    assert.match(comment.body, /https:\/\/github.com\/acme\/widgets\/runs\/1/);

    setGhRunner(gh("error"));
    const broken = createTask({ project: "pr", title: "Decision query failed", role: "decision", contract: "github:acme/widgets" });
    claimStatus(broken.id, "ready", "running", "test");
    await assert.rejects(async () => {
      await completeTask(broken.id, "decision", "Handoff", { pr });
    }, (err: unknown) => err instanceof KanbanError && err.code === "pr_checks");
    assert.equal(getTask(broken.id).status, "running");
    assert.match(getTask(broken.id).hold_reason ?? "", new RegExp("gh " + localePattern(zhCNPart("cardParts.event.prError", 2, 6))));
  });

  it("classifies the four gh outcomes without touching the board", async () => {
    const state = { kind: "github" as const, repo: "acme/widgets", pr, awaiting: false };
    assert.equal((await evaluateContract(state, gh("pass"))).kind, "pass");
    assert.equal((await evaluateContract(state, gh("wait"))).kind, "wait");
    assert.equal((await evaluateContract(state, gh("fail"))).kind, "fail");
    assert.equal((await evaluateContract(state, gh("error"))).kind, "error");
  });

  describe("paged checks, cache and backoff (TEST_0185 P1-8)", () => {
    const state = { kind: "github" as const, repo: "acme/widgets", pr, awaiting: false };
    const page = (names: string[]) => ({
      total_count: 150,
      check_runs: names.map((name) => ({ name, status: "completed", conclusion: "success", html_url: null })),
    });
    const many = Array.from({ length: 150 }, (_, i) => `xyz-${i}`);

    /** Behaves like gh: --paginate without --slurp prints the pages back to back, which is not one JSON value. */
    function pagedGh(calls: string[], opts: { statusPages?: unknown[][]; failChecks?: boolean } = {}): GhRunner {
      return async (args) => {
        const line = args.join(" ");
        calls.push(line);
        if (line.startsWith("pr view")) return JSON.stringify({ url: pr, headRefOid: sha, headRefName: "feature" });
        if (line.includes("/protection")) return JSON.stringify({ required_status_checks: { contexts: ["xyz-149", "legacy"] } });
        if (line.includes("/rules/")) return "[]";
        const slurp = args.includes("--slurp");
        const join = (pages: unknown[]) => (slurp ? JSON.stringify(pages) : pages.map((p) => JSON.stringify(p)).join(""));
        if (line.includes("/statuses")) {
          return join(opts.statusPages ?? [[{ context: "legacy", state: "success", target_url: null }]]);
        }
        if (line.includes("check-runs")) {
          if (opts.failChecks) throw new Error("gh: HTTP 502");
          return join([page(many.slice(0, 100)), page(many.slice(100))]);
        }
        throw new Error(line);
      };
    }

    it("merges every page of check-runs and statuses and asks gh for 100 per page", async () => {
      resetCheckCache();
      const calls: string[] = [];
      const verdict = await evaluateContract(state, pagedGh(calls, { statusPages: [[], [{ context: "legacy", state: "success", target_url: null }]] }));
      assert.equal(verdict.kind, "pass");
      for (const kind of ["check-runs", "statuses"]) {
        const call = calls.find((line) => line.includes(kind))!;
        assert.match(call, /--paginate/);
        assert.match(call, /--slurp/);
        assert.match(call, /per_page=100/);
      }
    });

    it("still parses pages printed back to back when gh cannot slurp", async () => {
      resetCheckCache();
      const base = pagedGh([]);
      const noSlurp: GhRunner = (args) => base(args.filter((arg) => arg !== "--slurp"));
      assert.equal((await evaluateContract(state, noSlurp)).kind, "pass");
    });

    it("reuses the checks of one head commit for a short while", async () => {
      resetCheckCache();
      const calls: string[] = [];
      const runner = pagedGh(calls);
      await evaluateContract(state, runner);
      await evaluateContract(state, runner);
      assert.equal(calls.filter((line) => line.includes("check-runs")).length, 1);
      assert.equal(calls.filter((line) => line.includes("/statuses")).length, 1);
    });

    it("backs off after gh fails on a commit instead of asking again at once", async () => {
      resetCheckCache();
      const calls: string[] = [];
      const runner = pagedGh(calls, { failChecks: true });
      assert.equal((await evaluateContract(state, runner)).kind, "error");
      const second = await evaluateContract(state, runner);
      assert.equal(second.kind, "error");
      assert.equal(calls.filter((line) => line.includes("check-runs")).length, 1);
    });

    it("stops a poll round once its time budget is spent", async () => {
      resetCheckCache();
      const calls: string[] = [];
      const verdict = await evaluateContract(state, pagedGh(calls), { deadline: Date.now() - 1 });
      assert.equal(verdict.kind, "error");
      assert.match((verdict as { summary: string }).summary, new RegExp(localePattern(zhCNPart("missingCwd.report.checkedAt", 2, 4))));
      assert.equal(calls.length, 0);
    });

    it("does not start a gh backoff when the poll budget runs out between calls", async () => {
      resetCheckCache();
      const calls: string[] = [];
      const base = pagedGh(calls);
      const runner: GhRunner = async (args) => {
        const out = await base(args);
        if (args.join(" ").includes("check-runs")) await new Promise((resolve) => setTimeout(resolve, 60));
        return out;
      };
      const first = await evaluateContract(state, runner, { deadline: Date.now() + 30 });
      assert.equal(first.kind, "error");
      assert.match((first as { summary: string }).summary, new RegExp(localePattern(zhCNPart("missingCwd.report.checkedAt", 2, 4))));
      const second = await evaluateContract(state, runner, { deadline: Date.now() + 10_000 });
      assert.equal(second.kind, "pass");
    });

    it("rotates the poll so a slow first card cannot starve the next one", async () => {
      resetCheckCache();
      const slowPr = "https://github.com/acme/widgets/pull/71";
      const fastPr = "https://github.com/acme/widgets/pull/72";
      const ids = [slowPr, fastPr].map((url) => {
        const task = createTask({ project: "pr", title: `Rotation ${url}`, role: "decision", contract: "github:acme/widgets" });
        claimStatus(task.id, "ready", "running", "test");
        getDb()
          .prepare("UPDATE tasks SET contract_json = ? WHERE id = ?")
          .run(JSON.stringify({ kind: "github", repo: "acme/widgets", pr: url, awaiting: true }), task.id);
        return task.id;
      });
      const base = gh("pass");
      setGhRunner(async (args) => {
        if (args.join(" ").startsWith("pr view 71")) await new Promise((resolve) => setTimeout(resolve, 60));
        return base(args.map((arg) => (arg === "71" || arg === "72" ? "7" : arg)));
      });
      const moved: number[][] = [];
      for (let round = 0; round < 3; round += 1) moved.push(await pollAwaitingPr(20));
      assert.ok(moved.flat().includes(ids[1]), `second card never checked: ${JSON.stringify(moved)}`);
      setGhRunner(null);
    });
  });
});

describe("repository and gh argument guards", () => {
  it("rejects dot segments in contracts and PR links", () => {
    for (const bad of ["github:../x", "github:acme/..", "github:./widgets"]) {
      assert.throws(() => readContract(bad), new RegExp(localePattern(zhCNPart("pr.contract.badRepo", 0, 6))));
    }
    assert.equal(parsePrUrl("https://github.com/../widgets/pull/7"), null);
    assert.equal(parsePrUrl("https://github.com/acme/../pull/7"), null);
    assert.ok(parsePrUrl("https://github.com/acme/widgets/pull/7"));
    assert.ok(parsePrUrl("https://github.com/acme/wid.gets/pull/7"));
  });

  it("refuses every gh api spelling that carries a body or changes the method", () => {
    const refused = [["-F", "a=b"], ["--field", "a=b"], ["--field=a=b"], ["-f", "a=b"], ["-fa=b"], ["-Fa=b"], ["--raw-field", "a=b"], ["-X", "POST"], ["--method=POST"], ["--input", "x"]];
    for (const extra of refused) assert.throws(() => assertReadOnly(["api", "repos/a/b", ...extra]), new RegExp(localePattern(zhCNPart("pr.gh.notReadOnly", 2, 5))), extra.join(" "));
    assert.doesNotThrow(() => assertReadOnly(["api", "--paginate", "repos/a/b/commits/c/check-runs"]));
    assert.doesNotThrow(() => assertReadOnly(["pr", "view", "7", "--repo", "a/b"]));
  });
});
