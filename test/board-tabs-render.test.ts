import { DARK_THEME } from "./helpers/theme-fixture";
/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { settle, trackClient } from "./helpers/settle";
import { PluginRpcProvider } from "../node_modules/@getpaseo/plugin/dist/client/rpc-context.js";
import { DEFAULT_PANEL_PREFS } from "../shared/panel-prefs";
import type { Layout, Theme } from "../client/ui";
import { boardCard, boardSnapshot, taskDetail } from "./helpers/board-fixture";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { KanbanBoard } = await import("../client/board");
const { CardDrawer } = await import("../client/card-drawer");
const { useStyles } = await import("../client/ui");
const hostUi = (await import("@getpaseo/plugin/client/react-native")) as unknown as { copied: string[]; __denyCopy(value: boolean): void };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type?: string; props?: Record<string, unknown>; children?: Array<Node | string> | null };
type Rendered = { toJSON(): Node | null; unmount(): void };
function nodes(node: Node | string | null, match: (node: Node) => boolean): Node[] {
  if (!node || typeof node === "string") return [];
  return [...(match(node) ? [node] : []), ...(node.children ?? []).flatMap((child) => nodes(child, match))];
}
function textOf(node: Node | string | null): string {
  if (!node) return "";
  return typeof node === "string" ? node : (node.children ?? []).map(textOf).join("");
}
const theme = DARK_THEME;
const layout = { compact: true, platform: "web" } as Layout;
async function press(renderer: Rendered, label: string) {
  const button = nodes(renderer.toJSON(), (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === "function")[0];
  assert.ok(button, `missing button ${label}`);
  await act(async () => (button.props!.onPress as () => void)());
  await settle();
}
function labels(renderer: Rendered): string[] {
  return nodes(renderer.toJSON(), (n) => typeof n.props?.accessibilityLabel === "string").map((n) => String(n.props!.accessibilityLabel));
}

type Invoke = (method: string, input: unknown) => Promise<unknown>;
async function mountBoard(board: ReturnType<typeof boardSnapshot>, extra: Record<string, (input: unknown) => unknown> = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const client = trackClient(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
  const invoke: Invoke = async (method, input) => {
    calls.push({ method, input });
    if (extra[method]) return extra[method]!(input);
    if (method === "kanban.board") return (input as { project?: string }).project ? { ...board, tasks: board.tasks.filter((t) => t.project === (input as { project: string }).project) } : board;
    if (method === "kanban.panel-prefs") return { ...DEFAULT_PANEL_PREFS, notice: null };
    if (method === "kanban.board-tab") return { tab: "overview" };
    if (method === "kanban.history") return { total: 0, items: [] };
    if (method === "kanban.task") return taskDetail(board.tasks.find((t) => t.id === (input as { id: number }).id) ?? board.tasks[0]!);
    throw new Error(`unexpected RPC ${method}`);
  };
  const renderer = await act(async () => TestRenderer.create(React.createElement(QueryClientProvider, { client },
    React.createElement(PluginRpcProvider, { invoke, children: React.createElement(KanbanBoard, { theme, layout, host: { id: "t", label: "T" }, navigation: { openAgent() {}, openWorkspace() {} } }) })))) as unknown as Rendered;
  await settle();
  return { renderer, calls, done: async () => { await act(async () => renderer.unmount()); client.clear(); } };
}

const cards = [
  boardCard({ id: 1, code: "XYZ_0001", status: "acceptance", badge: zhCN("labels.status.acceptance"), column: "doing" }),
  boardCard({ id: 2, code: "XYZ_0002", status: "blocked", badge: zhCN("labels.status.blocked"), column: "todo", blockedKind: "needs_human", blockedReason: "Missing key" }),
  boardCard({ id: 3, code: "XYZ_0003", status: "running" }),
  boardCard({ id: 4, code: "XYZ_0004", status: "done", badge: zhCN("labels.status.done"), column: "done" }),
];

describe("board tabs", () => {
  it("shows the five tabs with counts and switches content", async () => {
    const m = await mountBoard(boardSnapshot(cards));
    assert.deepEqual(labels(m.renderer).filter((l) => new RegExp(zhCN("common.comma") + "\\d+ " + localePattern(zhCNPart("board.intake.projectPlaceholder", 0, 1)) + "$|^" + zhCN("boardView.tab.settings") + "$").test(l)), [(zhCN("boardView.tab.overview") + zhCN("common.comma") + "3 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)), (zhCNPart("boardView.done.step", 2, 6) + "2 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)), (zhCNPart("decisions.card.goLeader", 7, 12) + "0 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)), (zhCN("boardView.tab.projects") + zhCN("common.comma") + "1 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)), zhCN("boardView.tab.settings")]);
    assert.ok(nodes(m.renderer.toJSON(), (n) => n.props?.testID === "board-columns").length === 1);
    await press(m.renderer, (zhCNPart("boardView.done.step", 2, 6) + "2 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)));
    assert.equal(nodes(m.renderer.toJSON(), (n) => n.props?.testID === "attention-view").length, 1);
    assert.equal(nodes(m.renderer.toJSON(), (n) => n.props?.testID === "board-columns").length, 0);
    const first = nodes(m.renderer.toJSON(), (n) => n.props?.testID === "kanban-card").map((n) => textOf(n));
    const reason = nodes(m.renderer.toJSON(), (n) => n.props?.testID === "card-reason").map((n) => textOf(n));
    assert.ok(reason[0]!.includes((zhCNPart("cardParts.alert.blocked", 0, 3) + "Missing key")), "the attention list shows the reason as visible text on line two");
    const status = nodes(m.renderer.toJSON(), (n) => n.props?.testID === "card-status").map((n) => String(n.props!.accessibilityLabel));
    assert.ok(status[0]!.includes((zhCNPart("cardParts.alert.blocked", 0, 3) + "Missing key")), "and it is read aloud with the status badge");
    assert.ok(first[0]!.includes("XYZ_0002"), "blocked comes before acceptance");
    assert.ok(first[1]!.includes("XYZ_0001"));
    assert.equal(first.length, 2);
    await press(m.renderer, (zhCN("boardView.tab.projects") + zhCN("common.comma") + "1 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)));
    assert.equal(nodes(m.renderer.toJSON(), (n) => n.props?.testID === "projects-view").length, 1);
    await press(m.renderer, zhCN("boardView.tab.settings"));
    assert.equal(nodes(m.renderer.toJSON(), (n) => n.props?.testID === "settings-panel").length, 1);
    await m.done();
  });

  it("saves the chosen tab and restores the saved one", async () => {
    const saved: unknown[] = [];
    const m = await mountBoard(boardSnapshot(cards), { "kanban.board-tab": (input) => { const tab = (input as { tab?: string }).tab; if (tab) saved.push(tab); return { tab: tab ?? "attention" }; } });
    assert.equal(nodes(m.renderer.toJSON(), (n) => n.props?.testID === "attention-view").length, 1, "restored the saved tab");
    await press(m.renderer, (zhCN("boardView.tab.overview") + zhCN("common.comma") + "3 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)));
    assert.deepEqual(saved, ["overview"]);
    await m.done();
  });

  it("badges an empty decisions tab and lists decisions when there are some", async () => {
    const item = { id: "d1", project: "demo_tasks", title: "XYZ_0002 Release scope", detail: "A sample B", blocking: true, status: "open" as const, createdAt: "2026-10-01T00:00:00Z", agentId: null, leader: { agentId: "l", reason: null } };
    const m = await mountBoard(boardSnapshot(cards, [item]));
    assert.ok(labels(m.renderer).includes((zhCNPart("decisions.card.goLeader", 7, 12) + "1 " + zhCNPart("board.intake.projectPlaceholder", 0, 1))));
    await press(m.renderer, (zhCNPart("decisions.card.goLeader", 7, 12) + "1 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)));
    assert.equal(nodes(m.renderer.toJSON(), (n) => n.props?.testID === "decisions-panel").length, 1);
    await m.done();
  });

  it("filters to one project from the by-project tab and goes back to the overview", async () => {
    const other = boardCard({ id: 9, code: "EX_0009", project: "ex", status: "running" });
    const board = boardSnapshot([...cards, other], [], {
      projects: ["demo_tasks", "ex"],
      projectRows: [
        { project: "ex", running: 1, acceptance: 0, blocked: 0, waiting: 0, done: 0, leaderAgentId: null, leaderTitle: null, lastLeaderActionAt: null },
        { project: "demo_tasks", running: 1, acceptance: 1, blocked: 1, waiting: 0, done: 1, leaderAgentId: "l", leaderTitle: "<leader> · demo_tasks", lastLeaderActionAt: "2026-10-01T00:00:00Z" },
      ],
    });
    const m = await mountBoard(board);
    await press(m.renderer, (zhCN("boardView.tab.projects") + zhCN("common.comma") + "2 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)));
    const text = textOf(m.renderer.toJSON());
    assert.match(text, new RegExp(zhCN("boardViews.projects.counts", {"running":"1","acceptance":"1","blocked":"1","waiting":"0"})));
    assert.match(text, new RegExp(zhCN("supervisor.view.headline", {"title":("<leader> · demo_tasks · " + zhCNPart("boardViews.projects.leader", 19, 23))})));
    assert.match(text, new RegExp(zhCN("supervisor.view.unregistered")));
    await press(m.renderer, zhCN("boardViews.projects.pick", {"project":"demo_tasks"}));
    assert.deepEqual(m.calls.filter((c) => c.method === "kanban.board").at(-1)?.input, { project: "demo_tasks" });
    assert.equal(nodes(m.renderer.toJSON(), (n) => n.props?.testID === "board-columns").length, 1);
    assert.ok(!textOf(m.renderer.toJSON()).includes("EX_0009"));
    await m.done();
  });
});

describe("long columns", () => {
  it("shows 30 cards first and the rest on request", async () => {
    const many = Array.from({ length: 65 }, (_, i) => boardCard({ id: 100 + i, code: `XYZ_${String(100 + i).padStart(4, "0")}`, status: "done", badge: zhCN("labels.status.done"), column: "done" }));
    const m = await mountBoard(boardSnapshot(many));
    const count = () => nodes(m.renderer.toJSON(), (n) => n.props?.testID === "kanban-card").length;
    assert.equal(count(), 30);
    assert.ok(textOf(m.renderer.toJSON()).includes((zhCNPart("boardViews.attention.more", 5, 8) + "35")));
    await press(m.renderer, zhCN("boardViews.column.moreLabel", {"column":"Done"}));
    assert.equal(count(), 60);
    await press(m.renderer, zhCN("boardViews.column.moreLabel", {"column":"Done"}));
    assert.equal(count(), 65);
    assert.ok(!labels(m.renderer).includes(zhCN("boardViews.column.moreLabel", {"column":"Done"})));
    await m.done();
  });
});

describe("compact card and detail drawer", () => {
  it("keeps the card to a couple of lines and opens the full detail on press", async () => {
    const m = await mountBoard(boardSnapshot(cards));
    const card = nodes(m.renderer.toJSON(), (n) => n.props?.testID === "kanban-card")[0]!;
    const body = textOf(card);
    assert.ok(!body.includes("GOAL-LONG-TEXT") && !body.includes("ACCEPT-LONG-TEXT"), "no five facts on the card");
    assert.ok(!body.includes(zhCN("cardParts.fact.assigner")) && !body.includes(zhCN("cardParts.fact.acceptance")));
    const lines = nodes(card, (n) => n.type === "Text" && n.props?.numberOfLines === 1);
    assert.ok(lines.length >= 2, "title and hint are single-line");
    assert.equal(nodes(m.renderer.toJSON(), (n) => n.props?.testID === "card-drawer").length, 0);
    await press(m.renderer, zhCN("compactCard.a11y.open", {"code":"XYZ_0001","title":"Release"}));
    const drawer = nodes(m.renderer.toJSON(), (n) => n.props?.testID === "card-drawer")[0]!;
    const text = textOf(drawer);
    for (const needle of [zhCN("cardDrawer.guide.title"), "GOAL-LONG-TEXT", "ACCEPT-LONG-TEXT", "BRIEF-FULL-TEXT", "HANDOFF-SUM", "REVIEW-OK", zhCN("cardDrawer.verdict.approve"), zhCN("cardDrawer.links.title"), zhCN("cardDrawer.timeline.title")]) {
      assert.ok(text.includes(needle), `drawer missing ${needle}`);
    }
    await press(m.renderer, zhCN("cardDrawer.close.label"));
    assert.equal(nodes(m.renderer.toJSON(), (n) => n.props?.testID === "card-drawer").length, 0);
    await m.done();
  });

  it("jumps between linked cards and expands the timeline to 20 events", async () => {
    const card = boardCard({ id: 5, code: "XYZ_0005", status: "running" });
    const parent = { id: 6, code: "XYZ_0006", title: "Parent details", status: "done", project: "demo_tasks" };
    const events = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, at: `2026-10-02T00:${String(i).padStart(2, "0")}:00Z`, kind: "comment", fromStatus: null, toStatus: null, actor: "x", data: "{}" }));
    const m = await mountBoard(boardSnapshot([card]), {
      "kanban.task": (input) => {
        const id = (input as { id: number }).id;
        return id === 6 ? taskDetail(boardCard({ id: 6, code: "XYZ_0006", title: "Parent details", status: "done" })) : taskDetail(card, { parents: [parent], events, pr: { url: "https://github.com/o/r/pull/1", repo: "o/r", awaiting: true, check: { kind: "pr_failed", at: "2026-10-02T00:00:00Z", summary: "lint Red" } } });
      },
    });
    await press(m.renderer, zhCN("compactCard.a11y.open", {"code":"XYZ_0005","title":"Release"}));
    const text = textOf(m.renderer.toJSON());
    assert.ok(text.includes("https://github.com/o/r/pull/1") && text.includes(zhCN("cardDrawer.check.failed")) && text.includes("lint Red"));
    assert.equal(nodes(m.renderer.toJSON(), (n) => typeof n.props?.accessibilityLabel === "string" && String(n.props.accessibilityLabel).startsWith(zhCNPart("cardDrawer.command.copyLabel", 0, 4))).length > 0, true);
    const rows = () => nodes(m.renderer.toJSON(), (n) => n.type === "Text" && new RegExp(zhCN("cardDrawer.comments.title") + "|" + zhCN("cardParts.event.created") + "|comment").test(textOf(n)) && /^2026-10-02/.test(textOf(n))).length;
    assert.equal(rows(), 5);
    await press(m.renderer, zhCN("cardDrawer.timeline.expand", {"count":"20"}));
    assert.equal(rows(), 20);
    await press(m.renderer, zhCN("cardDrawer.links.jump", {"label":zhCN("cardDrawer.links.parent"),"code":"XYZ_0006"}));
    assert.ok(textOf(m.renderer.toJSON()).includes("Parent details"));
    await m.done();
  });

  it("copies a handling command through the host clipboard and asks for a manual copy when it is denied", async () => {
    const card = boardCard({ id: 1, code: "XYZ_0017", status: "acceptance" });
    const m = await mountBoard(boardSnapshot([card]), { "kanban.task": () => taskDetail(card) });
    await press(m.renderer, zhCN("compactCard.a11y.open", {"code":"XYZ_0017","title":"Release"}));
    const label = zhCN("cardDrawer.command.copyLabel", {"command":"bin/kanban accept XYZ_0017"});
    await press(m.renderer, label);
    assert.deepEqual(hostUi.copied, ["bin/kanban accept XYZ_0017"]);
    assert.ok(textOf(m.renderer.toJSON()).includes(zhCN("cardDrawer.command.copied")));
    hostUi.__denyCopy(true);
    try {
      await press(m.renderer, label);
      assert.ok(textOf(m.renderer.toJSON()).includes(zhCN("cardDrawer.command.selectByHand")));
      assert.equal(hostUi.copied.length, 1);
    } finally {
      hostUi.__denyCopy(false);
    }
    await m.done();
  });
});

describe("handling guide in the drawer", () => {
  const gate = [
    ["acceptance", boardCard({ id: 1, status: "acceptance" }), {}, [zhCN("cardDrawer.guide.title"), zhCN("cardDrawer.guide.needsPerson", {"headline":(zhCNPart("decisions.hold.triage", 0, 11) + zhCN("tools.action.accept"))}), "bin/kanban accept XYZ_0017", ("bin/kanban rework XYZ_0017 --reason \"<" + zhCNPart("boardView.cmd.reworkReason", 1, 6) + "\""), ("30 " + zhCNPart("ui.duration.underMinute", 5, 7))]],
    ["blocked", boardCard({ id: 1, status: "blocked", blockedKind: "needs_human", blockedReason: "Missing key" }), {}, [zhCN("boardView.blocked.where", {"reason":"Missing key"}), zhCNPart("boardView.blocked.whoHuman", 0, 2), "bin/kanban unblock XYZ_0017", "bin/kanban pass XYZ_0017", "bin/kanban archive XYZ_0017"]],
    ["waiting", boardCard({ id: 1, status: "waiting", badge: zhCN("labels.badge.waitingParents", {"marks":"XYZ_0000"}), column: "todo" }), { parents: [{ id: 2, code: "XYZ_0000", title: "Parent", status: "running", project: "demo_tasks" }] }, [zhCN("cardDrawer.guide.noPerson", {"headline":zhCN("blocked.kind.dependency")}), (zhCNPart("cardDrawer.pr.awaiting", 0, 2) + "XYZ_0000 Parent" + zhCNPart("boardView.waiting.parent", 16, 22) + zhCN("labels.status.running") + "」")]],
    ["quota wait", boardCard({ id: 1, status: "ready", nextStep: (zhCN("blocked.prefix.quota") + "codex-pro" + zhCN("nativeSessions.sweep.reasonSep") + "5 " + zhCNPart("doctor.hours", 8, 10) + zhCNPart("waitingMetrics.badWindow", 2, 4)), column: "todo" }), {}, [zhCN("cardDrawer.guide.noPerson", {"headline":zhCN("boardView.quota.headline")}), (zhCN("blocked.prefix.quota") + "codex-pro" + zhCN("nativeSessions.sweep.reasonSep") + "5 " + zhCNPart("doctor.hours", 8, 10) + zhCNPart("waitingMetrics.badWindow", 2, 4)), zhCNPart("boardView.default.working", 12, 19)]],
    ["external wait", boardCard({ id: 1, status: "in_review", nextStep: (zhCN("blocked.prefix.external") + "CI Finished running") }), {}, [zhCN("cardDrawer.guide.noPerson", {"headline":zhCN("boardView.external.headline")}), (zhCN("blocked.prefix.external") + "CI Finished running"), zhCNPart("boardView.external.step", 69, 88)]],
    ["round-2 hold", boardCard({ id: 1, status: "rework", reviewRound: 2, leaderHold: true, badge: zhCN("labels.badge.rework", {"round":"2"}) }), { reviewHold: (zhCNPart("reviewHold.next.rework", 0, 23) + "XYZ_0017 --reason \"<" + zhCNPart("reviewHold.next.rework", 41, 45)) }, [zhCN("boardView.hold.headline", {"round":"2","leader":"<leader>"}), zhCNPart("reviewHold.lead.title", 17, 22), zhCNPart("boardView.hold.options", 22, 31), zhCNPart("reviewHold.next.check", 17, 21), ("bin/kanban rework XYZ_0017 --reason \"<" + zhCNPart("reviewHold.next.rework", 41, 45)), ("bin/kanban pass XYZ_0017 --note \"<" + zhCNPart("reviewHold.next.pass", 32, 36))]],
    ["done awaiting merge", boardCard({ id: 1, status: "done", awaitingMerge: true, column: "done", badge: zhCN("labels.status.done") }), {}, [zhCN("boardView.done.prHeadline"), zhCNPart("boardView.note.merge", 21, 30), ("bin/kanban comment XYZ_0017 \"" + zhCN("boardView.cmd.okToMerge") + "\""), "--role batch"]],
  ] as const;
  for (const [name, card, over, needles] of gate) {
    it(`${name}: shows the next step and copyable commands`, async () => {
      const client = trackClient(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
      const invoke: Invoke = async (method) => {
        if (method === "kanban.task") return taskDetail(card, over);
        throw new Error(`unexpected RPC ${method}`);
      };
      function Harness() {
        const s = useStyles(theme, layout, DEFAULT_PANEL_PREFS, true);
        return React.createElement(CardDrawer, { s, id: 1, decisions: [], leaders: {}, actions: { start() {}, unblock() {}, archive() {}, setTier() {} }, openAgent() {}, onOpen() {}, onClose() {} });
      }
      const renderer = await act(async () => TestRenderer.create(React.createElement(QueryClientProvider, { client },
        React.createElement(PluginRpcProvider, { invoke, children: React.createElement(Harness) })))) as unknown as Rendered;
      await settle();
      const guide = nodes(renderer.toJSON(), (n) => n.props?.testID === "handling-guide")[0];
      assert.ok(guide, "guide section is shown");
      const text = textOf(guide);
      for (const needle of needles) assert.ok(text.includes(needle), `${name}: guide missing "${needle}" in ${text}`);
      const copyable = nodes(guide, (n) => n.type === "Text" && n.props?.selectable === true).map(textOf);
      assert.ok(needles.filter((n) => n.startsWith("bin/kanban")).every((cmd) => copyable.some((line) => line.startsWith(cmd))), `${name}: commands are selectable text`);
      await act(async () => renderer.unmount());
      client.clear();
    });
  }
});
