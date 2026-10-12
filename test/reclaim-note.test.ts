/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
// TEST_0299: what a reclaim records about the departing agent, and what the next agent is told.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { closeDb, getDb } from "../server/db";
import { reclaimTask } from "../server/failures";
import { shellActions } from "../server/reclaim-actions";
import { readReclaimContext, reclaimedAgentNote, trailFromTimeline, workspaceFromDescriptor } from "../server/reclaim-note";
import { settleCanceledTurn } from "../server/presence";
import { appendEvent, createTask } from "../server/store";

const dir = mkdtempSync(join(tmpdir(), "reclaim-note-"));
process.env.KANBAN_DATA_DIR = dir;

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const shell = (command: string, exitCode: number | null, status = "completed") =>
  ({ type: "tool_call", callId: command, name: "Bash", status, error: null, detail: { type: "shell", command, exitCode } });

/** A running card with one open run for `agentId`. */
function runningCard(agentId: string, role = "batch"): number {
  const task = createTask({ project: "p", title: "merge", role, workspacePath: dir });
  const at = "2026-10-08T01:43:13.615Z";
  getDb().prepare("UPDATE tasks SET status = 'running', agent_id = ? WHERE id = ?").run(agentId, task.id);
  getDb().prepare(
    ("INSERT INTO runs (task_id, agent_id, role, profile_name, started_at) VALUES (?, ?, ?, '" + zhCN("labels.role.batch") + "', ?)"),
  ).run(task.id, agentId, role, at);
  return task.id;
}

// Synthetic values only (TEST_0299 review R1): none of these is a real credential.
const SYNTHETIC = "REVIEW_SYNTHETIC_7f3a9c";
const leakingCommands = [
  `curl -H "Authorization: Bearer ${SYNTHETIC}" -X POST https://api.example.test/deploy`,
  `curl -u deploy:${SYNTHETIC} https://api.example.test/hook -d x=1`,
  `curl -X POST https://api.example.test/v1 -d '{"api_key":"${SYNTHETIC}"}'`,
  `KANBAN_TOKEN=${SYNTHETIC} bin/kanban complete 5`,
  `git push https://user:${SYNTHETIC}@github.com/o/r.git HEAD:main`,
  `gh api -X PATCH repos/o/r/issues/3 -f body=${SYNTHETIC}`,
  `gh pr comment 354 --body "${SYNTHETIC}"`,
  `gh pr create --title t --body ${SYNTHETIC} --base dev --head feat/x`,
  `psql postgres://u:${SYNTHETIC}@db/x -c "update t set a=1"`,
  `git commit --message="${SYNTHETIC}"`,
  `echo ${SYNTHETIC} > /tmp/x`,
];

describe("shellActions: an allowlist, never the raw command", () => {
  it("keeps what matters for not repeating work: pushes, merges, PR and issue numbers, branch names", () => {
    assert.deepEqual(shellActions("git switch kanban/TEST2_0160-task && git push origin HEAD:kanban/TEST2_0160-task"), [
      "git switch kanban/TEST2_0160-task",
      "git push origin HEAD → kanban/TEST2_0160-task",
    ]);
    assert.deepEqual(shellActions("cd /x; GH_TOKEN=abc gh pr merge 354 --squash --delete-branch"), ["gh pr merge #354 --squash --delete-branch"]);
    assert.deepEqual(shellActions("gh pr merge https://github.com/o/r/pull/351 --merge"), ["gh pr merge #351 --merge"]);
    assert.deepEqual(shellActions("gh issue close 352 --comment done"), ["gh issue close #352"]);
    assert.deepEqual(shellActions("git checkout -b tmp0165 origin/kanban/TEST2_0160-task"), [("git checkout " + zhCNPart("workspaceRecreate.createFailed", 0, 3) + "tmp0165")]);
    assert.deepEqual(shellActions("git push --force-with-lease origin feat/x"), [("git push origin feat/x" + zhCN("reclaimActions.git.force"))]);
    assert.deepEqual(shellActions("git -C /repo rebase origin/dev"), ["git rebase origin/dev"]);
    assert.deepEqual(shellActions("sqlite3 data/kanban.db 'delete from t'"), [zhCN("reclaimActions.tool.args", {"label":(zhCNPart("reclaimActions.tool.database", 0, 6) + "sqlite3")})]);
    assert.deepEqual(shellActions("npm publish --access public"), ["npm publish"]);
    assert.deepEqual(shellActions("git branch -D old && git push --force origin feat/x"), [zhCN("reclaimActions.git.branchDelete"), ("git push origin feat/x" + zhCN("reclaimActions.git.force"))]);
  });

  it("ignores reads and local work", () => {
    for (const command of ["git status --short", "git log --oneline -3", "gh pr view 354 --json state", "npm test", "curl https://example.test", "gh api repos/o/r/pulls/3"]) {
      assert.deepEqual(shellActions(command), [], command);
    }
  });

  it("drops every synthetic credential form the review probed, and more", () => {
    for (const command of leakingCommands) {
      const out = shellActions(command).join("\n");
      assert.doesNotMatch(out, /REVIEW_SYNTHETIC/, command);
    }
    assert.deepEqual(shellActions(leakingCommands[0]!), [zhCN("reclaimActions.tool.http", {"tool":"curl","verb":"POST"})]);
    assert.deepEqual(shellActions(leakingCommands[4]!), [("git push <" + zhCNPart("reclaimActions.git.remote", 1, 4) + " HEAD → main")]);
    assert.deepEqual(shellActions(leakingCommands[7]!), ["gh pr create"]);
  });

  it("does not show a key-like branch or tag name", () => {
    assert.deepEqual(shellActions(`git push origin ghp_${"a".repeat(30)}`), ["git push origin"]);
    assert.deepEqual(shellActions(`git tag ${"Zq9".repeat(12)}`), ["git tag"]);
  });

  it("records gh release as its subcommand only, whatever the flags (TEST_0300 <leader> ruling)", () => {
    const RELEASE = (verb: string) => `gh release ${verb}${zhCNPart("reclaimActions.gh.release", 17, 50)}`;
    // Every probe from both review rounds, plus glued, `=` and unknown flags.
    const probes = [
      `gh release create --notes ${SYNTHETIC} v1.2.3`,
      `gh release create -n ${SYNTHETIC} v1.2.3`,
      `gh release create -p -n ${SYNTHETIC} v1.2.3`,
      `gh release create -p --notes ${SYNTHETIC} v1.2.3`,
      `gh release create -p --title ${SYNTHETIC} v1.2.3`,
      `gh release create -d -p -n ${SYNTHETIC} v1.2.3`,
      `gh release create -dp -n ${SYNTHETIC} v1.2.3`,
      `gh release create -dp ${SYNTHETIC}`,
      `gh release create --notes=${SYNTHETIC} ${SYNTHETIC}`,
      `gh release create --prerelease -n ${SYNTHETIC} v1.2.3`,
      `gh release create --some-new-option ${SYNTHETIC} v1.2.3`,
      `gh release create ${SYNTHETIC}`,
    ];
    for (const command of probes) {
      assert.deepEqual(shellActions(command), [RELEASE("create")], command);
      assert.doesNotMatch(shellActions(command).join("\n"), /REVIEW_SYNTHETIC|v1\.2\.3/, command);
    }
    assert.deepEqual(shellActions(`gh release edit --tag ${SYNTHETIC} v1.2.3`), [RELEASE("edit")]);
    assert.deepEqual(shellActions(`gh release upload --clobber v1.2.3 ${SYNTHETIC}`), [RELEASE("upload")]);
    assert.deepEqual(shellActions("gh release delete -y --cleanup-tag v1.2.3"), [RELEASE("delete")]);
  });

  it("keeps only a plain PR or issue number from gh pr / issue, never a branch or other word (TEST_0300 <leader> ruling)", () => {
    const cases: Array<[string, string]> = [
      ["gh pr merge -r -d 354", "gh pr merge #354 -r -d"],
      [`gh pr merge -t ${SYNTHETIC} -b ${SYNTHETIC} 354 -s -d`, "gh pr merge #354 -s -d"],
      [`gh pr comment -b ${SYNTHETIC} 354`, "gh pr comment #354"],
      [`gh pr comment --body=${SYNTHETIC} 354`, "gh pr comment #354"],
      [`gh issue close -c ${SYNTHETIC} -r completed 352`, "gh issue close #352"],
      ["gh issue close -c 12 352", "gh issue close #352"],
      [`gh pr review --body-file ${SYNTHETIC} --approve 354`, "gh pr review #354"],
      ["gh pr review -c 354", "gh pr review #354"],
      [`gh pr review -r -b ${SYNTHETIC} 354`, "gh pr review #354"],
      ["gh pr close --delete-branch 354", "gh pr close #354"],
      [`gh pr close --delete-branch --comment ${SYNTHETIC} 354`, "gh pr close #354"],
      ["gh pr ready --undo 354", "gh pr ready #354"],
      ["gh issue edit --remove-parent --remove-type 352", "gh issue edit #352"],
      ["gh pr merge https://github.com/o/r/pull/351 --merge", "gh pr merge #351 --merge"],
      [`gh pr merge ${SYNTHETIC}`, "gh pr merge"],
      ["gh pr merge feat/x --squash", "gh pr merge --squash"],
      [`gh pr create -p ${SYNTHETIC} -d --base dev --head feat/x`, "gh pr create"],
      [`gh issue create -p ${SYNTHETIC} -t ${SYNTHETIC}`, "gh issue create"],
      // An unknown flag may take the number with it; it never turns into a wrong one.
      ["gh pr edit --some-new-option 354", "gh pr edit"],
    ];
    for (const [command, expected] of cases) assert.deepEqual(shellActions(command), [expected], command);
  });

  it("checks token prefixes before treating hex as a commit, and never shows hex as a branch, tag or remote name (TEST_0300)", () => {
    const hex40 = "0123456789abcdef0123456789abcdef01234567";
    // A lone refspec is a branch name on both sides.
    assert.deepEqual(shellActions(`git push origin ${hex40}`), ["git push origin"]);
    assert.deepEqual(shellActions(`git push origin abc1234`), ["git push origin"]);
    // The source of src:dst is a commit; the destination is a branch.
    assert.deepEqual(shellActions(`git push origin ${hex40}:main`), [`git push origin ${hex40} → main`]);
    assert.deepEqual(shellActions(`git push origin HEAD:${hex40}`), ["git push origin HEAD"]);
    assert.deepEqual(shellActions(`git push ${hex40} main`), [("git push <" + zhCNPart("reclaimActions.git.remote", 1, 4) + " main")]);
    assert.deepEqual(shellActions(`git checkout -b ${hex40}`), [("git checkout " + zhCNPart("reclaimActions.git.create", 1, 3))]);
    assert.deepEqual(shellActions(`git tag ${hex40}`), ["git tag"]);
    // Where git takes a commit, a lowercase object id still shows; uppercase hex is not how git prints one.
    assert.deepEqual(shellActions(`git cherry-pick ${hex40}`), [`git cherry-pick ${hex40}`]);
    assert.deepEqual(shellActions("git checkout abc1234"), ["git checkout abc1234"]);
    assert.deepEqual(shellActions(`git cherry-pick ${hex40.toUpperCase()}`), ["git cherry-pick"]);
    // A token prefix wins even where a commit is expected.
    assert.deepEqual(shellActions(`git cherry-pick ghp_${"a".repeat(36)}`), ["git cherry-pick"]);
    assert.deepEqual(shellActions(`git push origin ghp_${"a".repeat(36)}:main`), ["git push origin main"]);
  });
});

describe("trailFromTimeline", () => {
  it("keeps the last ten operations with each call's result, counts other commands, and never keeps assistant text", () => {
    const items = Array.from({ length: 12 }, (_, n) => shell(`gh issue close ${n}`, n % 2));
    const trail = trailFromTimeline([
      ...items.map((item) => ({ item })),
      shell("npm test", 0),
      { type: "assistant_message", text: `token is ${SYNTHETIC}` },
      shell("gh pr merge 1", null, "running"),
      shell("git push origin feat/x", null, "failed"),
      { type: "tool_call", status: "completed", detail: { type: "read", filePath: "/x" } },
    ]);
    assert.equal(trail?.actions.length, 10);
    assert.equal(trail?.actions[0], ("gh issue close #4" + zhCNPart("missingCwd.none", 0, 1) + zhCNPart("compat.exitCode", 0, 4) + "0" + zhCNPart("missingCwd.none", 3, 4)));
    assert.deepEqual(trail?.actions.slice(-2), [("gh pr merge #1" + zhCNPart("boardViews.attention.more", 4, 6) + zhCNPart("reclaimNote.result.running", 1, 3) + zhCNPart("missingCwd.none", 3, 4)), ("git push origin feat/x" + zhCNPart("missingCwd.none", 0, 1) + zhCN("compat.run.failed") + zhCNPart("missingCwd.none", 3, 4))]);
    assert.equal(trail?.otherCommands, 1);
    assert.doesNotMatch(JSON.stringify(trail), /REVIEW_SYNTHETIC/);
  });

  it("returns null for nothing useful or an unreadable timeline", () => {
    assert.equal(trailFromTimeline(undefined), null);
    assert.equal(trailFromTimeline([{ type: "user_message", text: "brief" }, { type: "assistant_message", text: "done" }]), null);
  });
});

describe("synthetic credentials end to end (review R1)", () => {
  it("never reach the reclaimed event or the replacement prompt", async () => {
    const id = runningCard("leaky");
    const timeline = [
      ...leakingCommands.map((command) => shell(command, 0)),
      shell("gh pr merge 354 --squash", 0),
      { type: "assistant_message", text: `Authorization: Bearer ${SYNTHETIC}` },
    ];
    const paseo = {
      agents: { ref: () => ({ timeline: { refetch: async () => assert.fail("the turn carried its timeline") } }) },
      workspaces: { ref: () => ({ refresh: async () => null }) },
    } as unknown as PaseoApi;
    const found = await readReclaimContext(paseo, "leaky", "ws", { timeline });
    assert.equal(settleCanceledTurn(id, "leaky", "archived", { ...found, cancelReason: "agent closed" }), "reclaimed");
    const stored = (getDb().prepare("SELECT data_json FROM events WHERE task_id = ? AND kind = 'reclaimed'").get(id) as { data_json: string }).data_json;
    assert.doesNotMatch(stored, /REVIEW_SYNTHETIC/);
    const note = reclaimedAgentNote(id, "batch");
    assert.doesNotMatch(note, /REVIEW_SYNTHETIC/);
    assert.match(note, new RegExp("- gh pr merge #354 --squash" + localePattern(zhCNPart("missingCwd.none", 0, 1)) + localePattern(zhCNPart("compat.exitCode", 0, 4)) + "0" + localePattern(zhCNPart("missingCwd.none", 3, 4))));
    assert.match(note, new RegExp(zhCN("reclaimActions.tool.http", {"tool":"-","verb":"curl POST"}) + localePattern(zhCNPart("missingCwd.none", 0, 1)) + localePattern(zhCNPart("compat.exitCode", 0, 4)) + "0" + localePattern(zhCNPart("missingCwd.none", 3, 4))));
    assert.match(note, new RegExp(zhCN("reclaimNote.otherCommands", {"count":"\\d+"})));
  });
});

describe("workspaceFromDescriptor", () => {
  it("reads archivingAt and the tracked PR", () => {
    assert.deepEqual(
      workspaceFromDescriptor("ws", {
        archivingAt: "2026-10-08T01:49:31Z",
        githubRuntime: { pullRequest: { url: "https://x/pull/9", number: 9, headRefName: "feat", isMerged: true } },
      }),
      { id: "ws", archiving: true, pullRequest: { url: "https://x/pull/9", number: 9, headRefName: "feat", merged: true } },
    );
    assert.deepEqual(workspaceFromDescriptor("ws", { archivingAt: null, githubRuntime: null }), { id: "ws", archiving: false });
    assert.equal(workspaceFromDescriptor("ws", null), null);
  });
});

describe("readReclaimContext", () => {
  const paseo = (opts: { timeline?: () => Promise<unknown>; workspace?: () => Promise<unknown> }) => ({
    agents: { ref: () => ({ timeline: { refetch: opts.timeline ?? (async () => ({ entries: [] })) } }) },
    workspaces: { ref: () => ({ refresh: opts.workspace ?? (async () => null) }) },
  }) as unknown as PaseoApi;

  it("uses the ended turn's commands without asking Paseo for the timeline", async () => {
    const found = await readReclaimContext(
      paseo({ timeline: async () => assert.fail("timeline fetched"), workspace: async () => ({ archivingAt: "t" }) }),
      "a", "ws", { timeline: [shell("gh pr merge 2", 0)] },
    );
    assert.deepEqual(found, { trail: { actions: [("gh pr merge #2" + zhCNPart("missingCwd.none", 0, 1) + zhCNPart("compat.exitCode", 0, 4) + "0" + zhCNPart("missingCwd.none", 3, 4))], otherCommands: 0 }, workspace: { id: "ws", archiving: true } });
  });

  it("fetches the timeline tail when the event carried no commands, and records nothing when that fails", async () => {
    const fetched = await readReclaimContext(paseo({ timeline: async () => ({ entries: [{ item: shell("git push origin feat/x", 0) }] }) }), "a", null);
    assert.deepEqual(fetched, { trail: { actions: [("git push origin feat/x" + zhCNPart("missingCwd.none", 0, 1) + zhCNPart("compat.exitCode", 0, 4) + "0" + zhCNPart("missingCwd.none", 3, 4))], otherCommands: 0 } });
    const failed = await readReclaimContext(
      paseo({ timeline: async () => { throw new Error("Agent not found: a"); } }),
      "a", null, { timeline: [{ type: "assistant_message", text: "done" }] },
    );
    assert.deepEqual(failed, {});
  });

  it("gives up on a slow daemon instead of holding the reclaim", async () => {
    const never = () => new Promise<never>(() => undefined);
    const begin = Date.now();
    const found = await readReclaimContext(paseo({ timeline: never, workspace: never }), "a", "ws", { timeoutMs: 30 });
    assert.deepEqual(found, {});
    assert.ok(Date.now() - begin < 1000);
  });
});

describe("reclaimedAgentNote", () => {
  it("is empty for a card whose last run was not reclaimed", () => {
    const id = runningCard("fresh");
    assert.equal(reclaimedAgentNote(id, "batch"), "");
    getDb().prepare("UPDATE runs SET ended_at = ?, end_kind = 'completed' WHERE task_id = ?").run("2026-10-08T01:50:00Z", id);
    assert.equal(reclaimedAgentNote(id, "batch"), "");
  });

  it("names the reclaimed agent, the branch it pushed and asks for a check before acting", () => {
    const id = runningCard("gone-1");
    appendEvent(id, "branch_observed", null, null, "batch", { branch: "feat/x", head: "0123456789abcdef", pushed: true });
    assert.equal(reclaimTask(id, new Date("2026-10-08T01:49:31.350Z"), { fileState: "archived", apiState: "archived" }), "reclaimed");
    const note = reclaimedAgentNote(id, "batch");
    assert.match(note, new RegExp("^## " + localePattern(zhCNPart("reclaimNote.heading", 3, 16)) + "\\n" + localePattern(zhCNPart("reclaimNote.heading", 3, 13)) + "gone-1" + localePattern(zhCNPart("reclaimNote.run", 17, 21)) + zhCN("labels.role.batch") + localePattern(zhCNPart("missingCwd.none", 3, 4)) + "2026-10-08T01:43:13\\.615Z " + localePattern(zhCNPart("boardView.waiting.autoStart", 10, 13)) + "2026-10-08T01:49:31\\.350Z " + localePattern(zhCNPart("reclaimNote.run", 56, 66))));
    assert.match(note, new RegExp(localePattern(zhCNPart("reclaimNote.cause", 0, 3)) + "Paseo " + localePattern(zhCNPart("reclaimNote.cause.archived", 6, 18))));
    assert.match(note, new RegExp(zhCN("reclaimNote.branch", {"branch":"feat\\/x","head":"0","pushed":("123456789ab" + zhCN("reclaimNote.branch.pushed"))})));
    assert.match(note, new RegExp(localePattern(zhCNPart("reclaimNote.check", 49, 57))));
    assert.equal(reclaimedAgentNote(id, "executor"), "", "another role's run is not this agent's predecessor");
  });

  it("says the workspace went with the agent when the restart found Paseo archiving it", () => {
    const id = runningCard("gone-2");
    assert.equal(reclaimTask(id, new Date(), { source: "turn_canceled", apiState: "closed" }), "reclaimed");
    appendEvent(id, "paseo_workspace_archiving", null, null, "scheduler", { workspaceId: "ws", directory: "/d", state: "archiving" });
    assert.match(reclaimedAgentNote(id, "batch"), new RegExp(localePattern(zhCNPart("reclaimNote.cause", 0, 3)) + "Paseo " + localePattern(zhCNPart("reclaimNote.cause.workspace", 6, 25))));
  });

  it("explains a mid-turn close without workspace evidence", () => {
    const id = runningCard("gone-3");
    assert.equal(reclaimTask(id, new Date(), { source: "turn_canceled", apiState: "closed" }), "reclaimed");
    assert.match(reclaimedAgentNote(id, "batch"), new RegExp(localePattern(zhCNPart("reclaimNote.cause", 0, 3)) + "Paseo " + localePattern(zhCNPart("reclaimNote.cause.canceled", 6, 19))));
  });
});
