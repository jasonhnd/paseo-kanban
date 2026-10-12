import { DARK_THEME } from "./helpers/theme-fixture";
/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
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


const red = (over: Record<string, unknown> = {}) => ({ id: "r1", project: "demo_tasks", card: null, taskId: null, object: "/tmp/gone", symptom: zhCNPart("lane.createdNoDirectory", 6, 11), suggestion: "bin/kanban doctor --fix", ...over });
const ids = (renderer: Rendered, testID: string) => nodes(renderer.toJSON(), (n) => n.props?.testID === testID);

describe("attention tab: doctor, folded merge waits, paging", () => {
  it("lists doctor reds after the cards, counts them, and opens card reds", async () => {
    const cards = [
      boardCard({ id: 2, code: "XYZ_0002", status: "blocked", badge: zhCN("labels.status.blocked"), column: "todo", blockedReason: "Missing key" }),
      boardCard({ id: 3, code: "XYZ_0003", status: "running" }),
    ];
    const reds = [red(), red({ id: "r2", card: "XYZ_0003", taskId: 3, object: "XYZ_0003", symptom: ("agent " + zhCNPart("open.cwdMissing", 14, 18)), suggestion: "bin/kanban reclaim XYZ_0003" })];
    const m = await mountBoard(boardSnapshot(cards, [], { doctorReds: reds }), { "kanban.board-tab": () => ({ tab: "attention" }) });
    assert.ok(labels(m.renderer).includes((zhCNPart("boardView.done.step", 2, 6) + "3 " + zhCNPart("board.intake.projectPlaceholder", 0, 1))), "badge counts 1 card + 2 reds");
    const text = textOf(m.renderer.toJSON());
    assert.ok(text.indexOf("Missing key") < text.indexOf(zhCN("boardViews.doctor.title")), "doctor group after blocked cards");
    assert.match(text, /\/tmp\/gone/);
    assert.match(text, /bin\/kanban doctor --fix/);
    await press(m.renderer, zhCN("boardViews.doctor.open", {"card":"XYZ_0003"}));
    assert.equal(ids(m.renderer, "card-drawer").length, 1);
    assert.ok(m.calls.some((c) => c.method === "kanban.task" && (c.input as { id: number }).id === 3));
    await m.done();
  });

  it("shows no doctor group and no error when there is no report", async () => {
    const m = await mountBoard(boardSnapshot([boardCard({ id: 2, status: "blocked", badge: zhCN("labels.status.blocked"), column: "todo" })]), { "kanban.board-tab": () => ({ tab: "attention" }) });
    assert.equal(ids(m.renderer, "attention-doctor").length, 0);
    assert.equal(ids(m.renderer, "attention-view").length, 1);
    await m.done();
  });

  it("folds PR-merge waits into a closed group that does not count on the badge", async () => {
    const cards = [
      boardCard({ id: 2, code: "XYZ_0002", status: "acceptance", badge: zhCN("labels.status.acceptance"), column: "doing" }),
      boardCard({ id: 5, code: "XYZ_0005", status: "done", badge: zhCN("labels.status.done"), column: "done", awaitingMerge: true }),
      boardCard({ id: 6, code: "XYZ_0006", status: "done", badge: zhCN("labels.status.done"), column: "done", awaitingMerge: true }),
    ];
    const m = await mountBoard(boardSnapshot(cards), { "kanban.board-tab": () => ({ tab: "attention" }) });
    assert.ok(labels(m.renderer).includes((zhCNPart("boardView.done.step", 2, 6) + "1 " + zhCNPart("board.intake.projectPlaceholder", 0, 1))));
    assert.ok(labels(m.renderer).includes(zhCN("boardViews.quiet.label", {"count":"2"})));
    assert.ok(!textOf(m.renderer.toJSON()).includes("XYZ_0005"), "folded cards are hidden");
    await press(m.renderer, zhCN("boardViews.quiet.label", {"count":"2"}));
    assert.ok(textOf(m.renderer.toJSON()).includes("XYZ_0005"));
    assert.ok(textOf(m.renderer.toJSON()).includes("XYZ_0006"));
    await m.done();
  });

  it("pages urgent cards at 50", async () => {
    const many = Array.from({ length: 120 }, (_, i) => boardCard({ id: 100 + i, code: `XYZ_${String(100 + i).padStart(4, "0")}`, status: "acceptance", badge: zhCN("labels.status.acceptance"), column: "doing" }));
    const m = await mountBoard(boardSnapshot(many), { "kanban.board-tab": () => ({ tab: "attention" }) });
    const count = () => ids(m.renderer, "kanban-card").length;
    assert.equal(count(), 50);
    assert.ok(textOf(m.renderer.toJSON()).includes((zhCNPart("boardViews.attention.more", 5, 8) + "70")));
    await press(m.renderer, zhCN("boardViews.attention.moreLabel"));
    assert.equal(count(), 100);
    await press(m.renderer, zhCN("boardViews.attention.moreLabel"));
    assert.equal(count(), 120);
    assert.ok(!labels(m.renderer).includes(zhCN("boardViews.attention.moreLabel")));
    await m.done();
  });
});

describe("card drawer: round-2 hold", () => {
  async function drawer(card: ReturnType<typeof boardCard>, rounds: unknown[]) {
    const client = trackClient(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
    const invoke: Invoke = async (method) => {
      if (method === "kanban.task") return taskDetail(card, { holdRounds: rounds });
      throw new Error(`unexpected RPC ${method}`);
    };
    function Harness() {
      const s = useStyles(theme, layout, DEFAULT_PANEL_PREFS, true);
      return React.createElement(CardDrawer, { s, id: card.id, decisions: [], leaders: {}, actions: { start() {}, unblock() {}, archive() {}, setTier() {} }, openAgent() {}, onOpen() {}, onClose() {} });
    }
    const renderer = await act(async () => TestRenderer.create(React.createElement(QueryClientProvider, { client },
      React.createElement(PluginRpcProvider, { invoke, children: React.createElement(Harness) })))) as unknown as Rendered;
    await settle();
    return { renderer, done: async () => { await act(async () => renderer.unmount()); client.clear(); } };
  }

  it("shows both rejections in time order, findings folded until opened", async () => {
    const hold = boardCard({ id: 4, code: "XYZ_0004", status: "rework", leaderHold: true, reviewRound: 2 });
    const d = await drawer(hold, [
      { at: "2026-10-02T01:00:00Z", reason: "ROUND-ONE-REASON Full first-round text", findings: "FINDING-ONE" },
      { at: "2026-10-02T03:00:00Z", reason: "ROUND-TWO-REASON Full second-round text", findings: "" },
    ]);
    const box = ids(d.renderer, "hold-rounds")[0];
    assert.ok(box, "hold rounds section is shown");
    const text = textOf(box);
    assert.ok(text.includes(zhCN("cardDrawer.hold.title")));
    assert.ok(text.indexOf("ROUND-ONE-REASON") < text.indexOf("ROUND-TWO-REASON"));
    assert.ok(text.includes((zhCNPart("flow.comment.round3", 0, 2) + "1 " + zhCNPart("reviewHold.lead.rounds", 1, 2))) && text.includes(zhCNPart("flow.comment.round2", 0, 5)));
    assert.ok(!text.includes("FINDING-ONE"), "findings are folded");
    await press(d.renderer, (zhCN("boardView.round.reject", {"round":"1"}) + " · 2026-10-02 01:00 findings"));
    assert.ok(textOf(ids(d.renderer, "hold-rounds")[0]!).includes("FINDING-ONE"));
    await d.done();
  });

  it("does not show the section on a card that is not held", async () => {
    const d = await drawer(boardCard({ id: 4, status: "rework", reviewRound: 1 }), []);
    assert.equal(ids(d.renderer, "hold-rounds").length, 0);
    await d.done();
  });
});
