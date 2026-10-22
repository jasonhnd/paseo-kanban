/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import { BOARD_AGENT_ENV } from "../server/agent-env";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { KanbanError } from "../server/errors";
import {
  askPaseoAgent,
  auditView,
  cleanupOps,
  daemonAgentMissing,
  launcherFrom,
  snapshotRetryDelays,
  listActivePaseoAgents,
  listPaseoWorkspaces,
  readAgentActivity,
  readAgentEndNote,
  readAgentPage,
  readWorkspacePage,
  readStartupEvidence,
  snapshotFromRecord,
} from "../server/paseo";

const dir = mkdtempSync(join(tmpdir(), "kanban-paseo-api-"));
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(join(process.env.KANBAN_AGENTS_DIR, "bucket"), { recursive: true });

after(() => {
  delete process.env.KANBAN_AGENTS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const silenced = async <T>(body: () => Promise<T>): Promise<{ result: T; logs: string[] }> => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.join(" ")); };
  try {
    return { result: await body(), logs };
  } finally {
    console.error = original;
  }
};

const asPaseo = (value: unknown) => value as PaseoApi;
const workspaceRow = { id: "w1", workspaceKind: "worktree", archivingAt: null, projectRootPath: "/repo" };
const agentRow = { id: "a1", archivedAt: null };
snapshotRetryDelays.value = [1, 1, 1, 1];
const page = (entries: unknown[], nextCursor: unknown = null) => ({ entries, pageInfo: { nextCursor } });

describe("paseo list shapes", () => {
  it("rejects workspace pages and rows with a wrong shape", () => {
    const bad: [unknown, RegExp][] = [
      [null, new RegExp(zhCN("compat.board.notObject"))],
      [{ entries: 1 }, new RegExp(localePattern(zhCNPart("paseo.shape.agentListNoEntries", 8, 18)))],
      [{ entries: [] }, /pageInfo/],
      [page([], 5), new RegExp(localePattern(zhCNPart("compat.agents.archivedAt", 18, 23)))],
      [page([null]), new RegExp(localePattern(zhCNPart("paseo.shape.workspaceEntryNotObject", 10, 16)))],
      [page([{ ...workspaceRow, id: "" }]), new RegExp(localePattern(zhCNPart("paseo.shape.agentNoId", 6, 11)))],
      [page([{ ...workspaceRow, workspaceKind: "" }]), /workspaceKind/],
      [page([{ id: "w", workspaceKind: "x", projectRootPath: "/r" }]), /archivingAt/],
      [page([{ ...workspaceRow, archivingAt: 3 }]), /archivingAt/],
      [page([{ ...workspaceRow, projectRootPath: undefined }]), /projectRootPath/],
    ];
    for (const [input, pattern] of bad) assert.throws(() => readWorkspacePage(input), pattern);
  });

  it("names a workspace by title, then name, and marks archived and pinned", () => {
    const parsed = readWorkspacePage(page([
      { ...workspaceRow, title: " Titled ", name: "n", archivingAt: "2026-01-01", pinnedAt: "x", projectId: "p", workspaceDirectory: "/d" },
      { ...workspaceRow, id: "w2", name: "named" },
      { ...workspaceRow, id: "w3" },
    ], "next"));
    assert.equal(parsed.nextCursor, "next");
    assert.deepEqual(parsed.entries.map((entry) => entry.name), ["Titled", "named", null]);
    assert.equal(parsed.entries[0]?.archived, true);
    assert.equal(parsed.entries[0]?.pinned, true);
    assert.equal(parsed.entries[0]?.directory, "/d");
    assert.equal(parsed.entries[1]?.projectId, null);
  });

  it("rejects agent pages and rows with a wrong shape", () => {
    const bad: [unknown, RegExp][] = [
      [3, new RegExp(zhCN("compat.board.notObject"))],
      [{ entries: {} }, new RegExp(localePattern(zhCNPart("paseo.shape.agentListNoEntries", 8, 18)))],
      [{ entries: [] }, /pageInfo/],
      [page([], 1), new RegExp(localePattern(zhCNPart("compat.agents.archivedAt", 18, 23)))],
      [page([{}]), new RegExp(localePattern(zhCNPart("paseo.shape.agentEntryNoAgent", 10, 18)))],
      [page([{ agent: null }]), new RegExp(localePattern(zhCNPart("paseo.shape.agentEntryNoAgent", 10, 18)))],
      [page([{ agent: { archivedAt: null } }]), new RegExp(localePattern(zhCNPart("paseo.shape.agentNoId", 6, 11)))],
      [page([{ agent: { id: "a" } }]), /archivedAt/],
      [page([{ agent: { id: "a", archivedAt: null, workspaceId: 4 } }]), /workspaceId/],
    ];
    for (const [input, pattern] of bad) assert.throws(() => readAgentPage(input), pattern);
  });

  it("keeps string labels only and fills defaults for optional agent fields", () => {
    const parsed = readAgentPage(page([
      { agent: { ...agentRow, workspaceId: "w", labels: { a: "1", b: 2 }, createdAt: "t", cwd: "/c", title: "T" } },
      { agent: { ...agentRow, id: "a2", archivedAt: "x", labels: ["no"] } },
    ]));
    assert.deepEqual(parsed.agents[0]?.labels, { a: "1" });
    assert.equal(parsed.agents[1]?.archived, true);
    assert.equal(parsed.agents[1]?.labels, undefined);
    assert.equal(parsed.agents[1]?.title, "");
    assert.equal(parsed.agents[1]?.cwd, null);
  });
});

describe("paseo paging", () => {
  it("follows cursors across pages", async () => {
    const seen: unknown[] = [];
    const paseo = asPaseo({
      workspaces: {
        list: async (request: { page: { cursor?: string } }) => {
          seen.push(request.page.cursor);
          return request.page.cursor ? page([{ ...workspaceRow, id: "w2" }]) : page([workspaceRow], "c1");
        },
      },
    });
    const all = await listPaseoWorkspaces(paseo);
    assert.deepEqual(all.map((entry) => entry.id), ["w1", "w2"]);
    assert.deepEqual(seen, [undefined, "c1"]);
  });

  it("fails when the cursor does not advance", async () => {
    const paseo = asPaseo({ agents: { list: async () => page([{ agent: agentRow }], "same") } });
    await assert.rejects(listActivePaseoAgents(paseo), (err) => err instanceof KanbanError && new RegExp(localePattern(zhCNPart("paseo.shape.cursorStuck", 21, 25))).test(err.message));
  });

  it("fails after 50 pages instead of returning a partial list", async () => {
    let n = 0;
    const paseo = asPaseo({ agents: { list: async () => page([{ agent: agentRow }], `c${n++}`) } });
    await assert.rejects(listActivePaseoAgents(paseo), new RegExp(localePattern(zhCNPart("paseo.shape.tooManyPages", 8, 15))));
  });

  it("exposes the active agents and a workspace snapshot through the audit view", async () => {
    const paseo = asPaseo({
      agents: { list: async () => page([{ agent: { ...agentRow, workspaceId: "w1" } }]) },
      workspaces: { ref: () => ({ current: () => workspaceRow, refresh: async () => workspaceRow }) },
    });
    const view = auditView(paseo);
    assert.deepEqual((await view.listActiveAgents()).map((agent) => agent.id), ["a1"]);
    assert.equal((await view.inspectWorkspace("w1"))?.id, "w1");
  });

  it("reports a workspace that cannot be refreshed as absent", async () => {
    const paseo = asPaseo({ workspaces: { ref: () => ({ current: () => null, refresh: async () => null }) } });
    assert.equal(await auditView(paseo).inspectWorkspace("gone"), null);
  });
});

describe("paseo agent snapshots", () => {
  const agentApi = (handle: Record<string, unknown>) => asPaseo({ agents: { ref: () => handle } });

  it("answers absent, or the typed view of the agent", async () => {
    assert.equal(await askPaseoAgent(agentApi({ refresh: async () => null, current: () => null }), "a"), "absent");
    const view = await askPaseoAgent(agentApi({ refresh: async () => ({ agent: { status: 7, archivedAt: "t", activeTurn: undefined } }), current: () => null }), "a");
    assert.deepEqual(view, { status: null, archivedAt: "t", activeTurn: null });
  });

  it("recognizes only the daemon's not-found message as a missing agent", () => {
    assert.equal(daemonAgentMissing(new Error("Agent not found: a1")), true);
    assert.equal(daemonAgentMissing("Agent not found"), true);
    assert.equal(daemonAgentMissing(new Error("timeout")), false);
  });

  it("reads activity from the live agent", async () => {
    const paseo = agentApi({
      refresh: async () => ({ agent: { status: "running", cwd: "/nonexistent-dir" } }),
      current: () => null,
    });
    assert.equal((await readAgentActivity(paseo, "a1")).state, "busy");
  });

  it("falls back to the record file when the daemon cannot be asked", async () => {
    writeFileSync(join(dir, "agents", "bucket", "a-file.json"), JSON.stringify({
      id: "a-file", cwd: "/nonexistent-dir", lastStatus: "idle", updatedAt: "2026-01-01T00:00:00.000Z", labels: {}, internal: false,
    }));
    const paseo = agentApi({ refresh: async () => { throw new Error("socket closed"); } });
    const { result, logs } = await silenced(() => readAgentActivity(paseo, "a-file"));
    assert.equal(result.state, "idle");
    assert.deepEqual(logs, ["[paseo-kanban] stall socket closed"]);
  });

  it("adds the last assistant text from the timeline tail for an idle agent with a real cwd", async () => {
    const paseo = agentApi({
      refresh: async () => ({ agent: { status: "idle", cwd: dir, updatedAt: "2026-01-01T00:00:00.000Z" } }),
      timeline: { refetch: async () => ({ entries: [{ timestamp: "2026-01-02T00:00:00.000Z", item: { type: "assistant_message", text: " all done " } }] }) },
    });
    const activity = await readAgentActivity(paseo, "a1");
    assert.equal(activity.lastAssistant, "all done");
    assert.equal(activity.lastAt, "2026-01-02T00:00:00.000Z");
  });

  it("logs a timeline failure and keeps the earlier activity", async () => {
    const paseo = agentApi({
      refresh: async () => ({ agent: { status: "idle", cwd: dir, updatedAt: "2026-01-01T00:00:00.000Z" } }),
      timeline: { refetch: async () => { throw new Error("no timeline"); } },
    });
    const { result, logs } = await silenced(() => readAgentActivity(paseo, "a1"));
    assert.equal(result.state, "idle");
    assert.deepEqual(logs, ["[paseo-kanban] stall no timeline"]);
  });

  it("collects the end note from lastError, the timeline tail and the record", async () => {
    writeFileSync(join(dir, "agents", "bucket", "a-note.json"), JSON.stringify({
      id: "a-note", cwd: "/x", lastStatus: "error", lastError: "record error", labels: {}, internal: false,
    }));
    const paseo = agentApi({
      refresh: async () => ({ agent: { lastError: " live error " } }),
      timeline: { refetch: async () => ({ entries: [{ type: "error", message: "timeline error" }] }) },
    });
    assert.equal(await readAgentEndNote(paseo, "a-note"), "live error\ntimeline error\nrecord error");
  });

  it("returns null when nothing has text, logging timeline and refresh failures", async () => {
    const timelineFails = agentApi({ refresh: async () => null, current: () => null, timeline: { refetch: async () => { throw new Error("tl"); } } });
    const refreshFails = agentApi({ refresh: async () => { throw new Error("rf"); } });
    const first = await silenced(() => readAgentEndNote(timelineFails, "nobody"));
    const second = await silenced(() => readAgentEndNote(refreshFails, "nobody"));
    assert.equal(first.result, null);
    assert.deepEqual(first.logs, ["[paseo-kanban] login tl"]);
    assert.equal(second.result, null);
    assert.deepEqual(second.logs, ["[paseo-kanban] login rf"]);
  });

  it("reads archived and busy from the record file, null when missing, and throws when unreadable", () => {
    writeFileSync(join(dir, "agents", "bucket", "a-busy.json"), JSON.stringify({
      id: "a-busy", cwd: "/x", lastStatus: "running", archivedAt: "t", labels: {}, internal: false,
    }));
    assert.deepEqual(snapshotFromRecord("a-busy"), { archived: true, busy: true });
    assert.equal(snapshotFromRecord("absent-agent"), null);
    const saved = process.env.KANBAN_AGENTS_DIR;
    process.env.KANBAN_AGENTS_DIR = join(dir, "does-not-exist");
    try {
      assert.throws(() => snapshotFromRecord("a-busy"), new RegExp(zhCN("paseo.agent.lookupFailed")));
    } finally {
      process.env.KANBAN_AGENTS_DIR = saved;
    }
  });
});

describe("paseo cleanup operations", () => {
  const apiWith = (handle: Record<string, unknown>) => asPaseo({ agents: { ref: () => handle } });

  it("uses a live snapshot when the daemon has the agent", async () => {
    const ops = cleanupOps(apiWith({ refresh: async () => ({ agent: { status: "running", archivedAt: null } }) }));
    assert.deepEqual(await ops.inspectAgent?.("a1"), { archived: false, busy: true });
  });

  it("falls back to the record when the daemon says the agent does not exist", async () => {
    const ops = cleanupOps(apiWith({ refresh: async () => { throw new Error("Agent not found: x"); } }));
    assert.equal(await ops.inspectAgent?.("absent-agent"), null);
  });

  it("fails the lookup for any other daemon error", async () => {
    const ops = cleanupOps(apiWith({ refresh: async () => { throw new Error("timeout"); } }));
    const { logs } = await silenced(async () => {
      await assert.rejects(ops.inspectAgent?.("a1") ?? Promise.resolve(), new RegExp(zhCN("paseo.agent.lookupFailed")));
    });
    assert.deepEqual(logs, ["[paseo-kanban] inspect agent timeout"]);
  });

  it("forwards archive and list calls to the launcher", async () => {
    const archived: string[] = [];
    const paseo = asPaseo({
      agents: {
        ref: (id: string) => ({ archive: async () => { archived.push(`agent:${id}`); } }),
        list: async () => page([{ agent: { ...agentRow, workspaceId: "w1" } }, { agent: { id: "a2", archivedAt: "t", workspaceId: "other" } }]),
      },
      workspaces: {
        archive: async (id: string) => { archived.push(`workspace:${id}`); },
        ref: () => ({ current: () => workspaceRow, refresh: async () => workspaceRow }),
      },
    });
    const ops = cleanupOps(paseo);
    await ops.archiveAgent("a1");
    await ops.archiveWorkspace("w1");
    assert.deepEqual(archived, ["agent:a1", "workspace:w1"]);
    assert.deepEqual(await ops.listAgents("w1"), [{ id: "a1", archived: false }]);
    assert.equal((await ops.inspectWorkspace("w1"))?.id, "w1");
  });
});

describe("paseo launcher", () => {
  it("opens an agent inside an existing workspace and remembers kanban-marked agents", async () => {
    const created: unknown[] = [];
    const paseo = asPaseo({
      workspaces: { ref: (id: string) => ({ agents: { create: async (options: unknown) => { created.push([id, options]); return { id: "new-agent" }; } } }) },
    });
    const made = await launcherFrom(paseo).create({
      workspaceId: "w1", cwd: "/c", title: "T", prompt: "P", labels: {}, env: { [BOARD_AGENT_ENV]: "1" }, config: {},
    } as never);
    assert.deepEqual(made, { id: "new-agent", workspaceId: "w1" });
    assert.equal(created.length, 1);
  });

  it("opens an agent by cwd when there is no workspace id", async () => {
    const paseo = asPaseo({ agents: { create: async () => ({ id: "cwd-agent", workspaceId: "w9" }) } });
    const made = await launcherFrom(paseo).create({ cwd: "/c", title: "T", prompt: "P", labels: {}, env: {}, config: {} } as never);
    assert.deepEqual(made, { id: "cwd-agent", workspaceId: "w9" });
  });

  it("sends text, lists models and workspaces through the client", async () => {
    const sent: string[] = [];
    const paseo = asPaseo({
      agents: { ref: () => ({ send: async (text: string) => { sent.push(text); } }) },
      providers: { listModels: async (provider: string) => [provider] },
      workspaces: { list: async () => page([workspaceRow]) },
    });
    const launcher = launcherFrom(paseo);
    await launcher.send?.("a1", "hello");
    assert.deepEqual(sent, ["hello"]);
    assert.deepEqual(await launcher.listModels?.("claude"), ["claude"]);
    assert.equal((await launcher.listWorkspaces?.())?.length, 1);
  });

  it("creates a directory workspace and names it from the snapshot title, then name", async () => {
    const paseo = asPaseo({
      workspaces: {
        create: async () => ({ id: "dw", name: "handle-name", directory: "/dir", current: () => ({ title: " Snap ", name: "n", workspaceDirectory: "/snap" }), refresh: async () => null }),
      },
    });
    assert.deepEqual(await launcherFrom(paseo).createDirectoryWorkspace?.({ cwd: "/cwd" } as never), { id: "dw", directory: "/snap", name: "Snap" });
  });

  it("falls back to the handle and cwd for a directory workspace without a snapshot", async () => {
    const paseo = asPaseo({
      workspaces: { create: async () => ({ id: "dw", name: "handle-name", current: () => null, refresh: async () => null }) },
    });
    assert.deepEqual(await launcherFrom(paseo).createDirectoryWorkspace?.({ cwd: "/cwd" } as never), { id: "dw", directory: "/cwd", name: "handle-name" });
  });

  const worktreeApi = (snapshot: unknown, handleExtra: Record<string, unknown> = {}, archived: string[] = []) => asPaseo({
    workspaces: {
      create: async () => ({
        id: "wt", name: "wt-name", current: () => snapshot, refresh: async () => null,
        archive: async () => { archived.push("wt"); }, ...handleExtra,
      }),
    },
  });

  it("creates a worktree workspace and reads HEAD for a read-only card", async () => {
    const snapshot = { workspaceDirectory: process.cwd(), title: "", name: "snap-name", projectId: "p" };
    const made = await launcherFrom(worktreeApi(snapshot)).createWorktree?.({
      cwd: process.cwd(), baseBranch: "main", branchName: "b", title: "T", projectId: "p", readOnly: true,
    } as never);
    assert.equal(made?.workspaceId, "wt");
    assert.equal(made?.name, "snap-name");
    assert.match(String((made as { head?: string }).head), /^[0-9a-f]{40}$/);
  });

  it("omits HEAD for a writable worktree", async () => {
    const snapshot = { workspaceDirectory: "/wt", title: "T" };
    const made = await launcherFrom(worktreeApi(snapshot)).createWorktree?.({ cwd: "/c", baseBranch: "main", branchName: "b" } as never);
    assert.deepEqual(made, { directory: "/wt", workspaceId: "wt", name: "T" });
  });

  it("passes a rebuild's worktreeSlug in the worktree source, and leaves it out otherwise (TEST_0268)", async () => {
    const requests: Array<{ source?: Record<string, unknown> }> = [];
    const paseo = asPaseo({
      workspaces: {
        create: async (request: { source?: Record<string, unknown> }) => {
          requests.push(request);
          return { id: "wt", name: "n", current: () => ({ workspaceDirectory: "/wt" }), refresh: async () => null };
        },
      },
    });
    await launcherFrom(paseo).createWorktree?.({ cwd: "/c", baseBranch: "main", branchName: "b", worktreeSlug: "kanban-demo-0003-pre-r1" });
    await launcherFrom(paseo).createWorktree?.({ cwd: "/c", baseBranch: "main", branchName: "b" });
    assert.equal(requests[0].source?.worktreeSlug, "kanban-demo-0003-pre-r1");
    assert.equal(requests[0].source?.kind, "worktree");
    assert.equal("worktreeSlug" in (requests[1].source ?? {}), false);
  });

  it("archives and refuses a worktree registered under another project", async () => {
    const archived: string[] = [];
    const snapshot = { workspaceDirectory: "/wt", projectId: "other" };
    await assert.rejects(
      launcherFrom(worktreeApi(snapshot, {}, archived)).createWorktree?.({ cwd: "/c", baseBranch: "main", branchName: "b", projectId: "mine" } as never) ?? Promise.resolve(),
      (err) => err instanceof KanbanError && new RegExp(localePattern(zhCNPart("paseo.worktree.wrongProject", 14, 19))).test(err.message),
    );
    assert.deepEqual(archived, ["wt"]);
  });

  it("refreshes a stale non-git snapshot once and retries the worktree, archiving the duplicate workspace", async () => {
    const archivedIds: string[] = [];
    const created: unknown[] = [];
    let worktreeAttempts = 0;
    const paseo = asPaseo({
      workspaces: {
        list: async () => page([{ ...workspaceRow, id: "main-ws" }]),
        archive: async (id: string) => { archivedIds.push(id); },
        create: async (input: { source: { kind: string } }) => {
          created.push(input.source.kind);
          if (input.source.kind === "directory") return { id: "dup-ws", name: "main", current: () => null, refresh: async () => null };
          worktreeAttempts += 1;
          if (worktreeAttempts === 1) throw new Error("Create worktree requires a git repository");
          return { id: "wt", name: "wt-name", current: () => ({ workspaceDirectory: "/wt", title: "T" }), refresh: async () => null, archive: async () => undefined };
        },
      },
    });
    const made = await launcherFrom(paseo).createWorktree?.({ cwd: "/c", baseBranch: "main", branchName: "b" } as never);
    assert.deepEqual(made, { directory: "/wt", workspaceId: "wt", name: "T" });
    assert.deepEqual(created, ["worktree", "directory", "worktree"]);
    assert.deepEqual(archivedIds, ["dup-ws"]);
  });

  it("waits for the background snapshot refresh instead of retrying only once", async () => {
    // The daemon writes the snapshot back only after a few polls; an immediate single retry would still fail.
    let worktreeAttempts = 0;
    const refreshed = () => worktreeAttempts > 3;
    const paseo = asPaseo({
      workspaces: {
        list: async () => page([{ ...workspaceRow, id: "main-ws" }]),
        archive: async () => undefined,
        create: async (input: { source: { kind: string } }) => {
          if (input.source.kind === "directory") return { id: "main-ws", name: "main", current: () => null, refresh: async () => null };
          worktreeAttempts += 1;
          if (!refreshed()) throw new Error("Create worktree requires a git repository");
          return { id: "wt", name: "wt-name", current: () => ({ workspaceDirectory: "/wt", title: "T" }), refresh: async () => null, archive: async () => undefined };
        },
      },
    });
    const made = await launcherFrom(paseo).createWorktree?.({ cwd: "/c", baseBranch: "main", branchName: "b" } as never);
    assert.equal(made?.workspaceId, "wt");
    assert.ok(worktreeAttempts >= 4, `attempts=${worktreeAttempts}`);
  });

  it("keeps the original workspace when the refresh returns an already-listed one, and gives up after the bounded retries", async () => {
    const archivedIds: string[] = [];
    const paseo = asPaseo({
      workspaces: {
        list: async () => page([{ ...workspaceRow, id: "main-ws" }]),
        archive: async (id: string) => { archivedIds.push(id); },
        create: async (input: { source: { kind: string } }) => {
          if (input.source.kind === "directory") return { id: "main-ws", name: "main", current: () => null, refresh: async () => null };
          throw new Error("Create worktree requires a git repository");
        },
      },
    });
    await assert.rejects(
      launcherFrom(paseo).createWorktree?.({ cwd: "/c", baseBranch: "main", branchName: "b" } as never) ?? Promise.resolve(),
      /requires a git repository/,
    );
    assert.deepEqual(archivedIds, []);
  });

  it("does not retry unrelated worktree failures", async () => {
    let calls = 0;
    const paseo = asPaseo({ workspaces: { create: async () => { calls += 1; throw new Error("boom"); } } });
    await assert.rejects(launcherFrom(paseo).createWorktree?.({ cwd: "/c", baseBranch: "main", branchName: "b" } as never) ?? Promise.resolve(), /boom/);
    assert.equal(calls, 1);
  });

  it("refuses a worktree that came back without a directory", async () => {
    await assert.rejects(
      launcherFrom(worktreeApi(null)).createWorktree?.({ cwd: "/c", baseBranch: "main", branchName: "b" } as never) ?? Promise.resolve(),
      new RegExp(zhCN("workspaceRecreate.noDirectoryReturned")),
    );
  });

  it("inspects an agent as archived, absent, or fails on other errors", async () => {
    const handleFor = (refresh: () => Promise<unknown>) => asPaseo({ agents: { ref: () => ({ refresh, current: () => null }) } });
    assert.deepEqual(await launcherFrom(handleFor(async () => ({ agent: { archivedAt: "t" } }))).inspectAgent?.("a"), { archived: true });
    assert.equal(await launcherFrom(handleFor(async () => null)).inspectAgent?.("a"), null);
    assert.equal(await launcherFrom(handleFor(async () => { throw new Error("Agent not found: a"); })).inspectAgent?.("a"), null);
    await assert.rejects(launcherFrom(handleFor(async () => { throw new Error("timeout"); })).inspectAgent?.("a") ?? Promise.resolve(), /timeout/);
  });

  it("runs the beforeStart hook it was given", async () => {
    let ran = 0;
    const launcher = launcherFrom(asPaseo({}), async () => { ran += 1; });
    await launcher.beforeStart?.();
    assert.equal(ran, 1);
  });

  it("refreshes a workspace even when its cached descriptor still looks live", async () => {
    const descriptor = { id: "w", workspaceDirectory: "/copy", workspaceKind: "worktree", projectRootPath: "/root", archivingAt: "archive-started" };
    let refreshed = 0;
    const launcher = launcherFrom(asPaseo({ workspaces: { ref: () => ({
      current: () => ({ ...descriptor, archivingAt: null }),
      refresh: async () => { refreshed += 1; return descriptor; },
    }) } }));
    assert.equal((await launcher.inspectWorkspace!("w"))?.archived, true);
    assert.equal(refreshed, 1);
  });

  for (const problem of ["none", "tool", "older", "newer", "gap", "stale", "compaction", "plugin", "unknown", "error", "projected", "wrong-agent", "retained-prefix"] as const) {
    it(`requires complete canonical startup evidence: ${problem}`, async () => {
      const page = {
        agentId: "a", projection: "canonical", error: null as string | null,
        hasOlder: false, hasNewer: false, gap: false, staleCursor: false,
        window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
        entries: [{ seqStart: 1, seqEnd: 1, item: { type: "user_message" } }, { seqStart: 2, seqEnd: 2, item: { type: "assistant_message" } }],
      };
      if (problem === "tool") page.entries.push({ seqStart: 3, seqEnd: 3, item: { type: "tool_call" } });
      if (problem === "older") page.hasOlder = true;
      if (problem === "newer") page.hasNewer = true;
      if (problem === "gap") page.gap = true;
      if (problem === "stale") page.staleCursor = true;
      if (["compaction", "plugin", "unknown"].includes(problem)) page.entries.push({ seqStart: 3, seqEnd: 3, item: { type: problem } });
      if (problem === "error") page.error = "partial read";
      if (problem === "projected") page.projection = "projected";
      if (problem === "wrong-agent") page.agentId = "other-agent";
      if (problem === "retained-prefix") page.window.minSeq = 9;
      const api = asPaseo({
        agents: { ref: () => ({
          refresh: async () => ({ agent: { archivedAt: "archived", status: "closed", activeTurn: null, workspaceId: "w", labels: { kanban_start_generation: "generation" } } }),
          timeline: { refetch: async (options: unknown) => {
            assert.deepEqual(options, { direction: "tail", limit: 1000, projection: "canonical" });
            return page;
          } },
        }) },
        workspaces: { ref: () => ({ refresh: async () => ({ archivingAt: "archiving", githubRuntime: { pullRequest: { isMerged: true, url: "https://github.com/o/r/pull/22" } } }) }) },
      });
      const proof = await readStartupEvidence(api, "a", "w");
      assert.equal(proof?.archived, true);
      assert.equal(proof?.merged, true);
      assert.equal(proof?.timelineComplete, problem === "none");
      assert.equal(proof?.toolCalls, problem === "tool" ? 1 : 0);
      assert.equal(proof?.generation, "generation");
    });
  }
});
