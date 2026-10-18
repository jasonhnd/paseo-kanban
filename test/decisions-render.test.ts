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
import type { DecisionView } from "../shared/decisions";
import { DEFAULT_PANEL_PREFS } from "../shared/panel-prefs";
import type { Layout, Styles, Theme } from "../client/ui";
import { boardCard, boardSnapshot, taskDetail } from "./helpers/board-fixture";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { DecisionsPanel, CardAttention, ProjectAttention } = await import("../client/decisions");
const { KanbanBoard } = await import("../client/board");
const { useStyles } = await import("../client/ui");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type?: string; props?: Record<string, unknown>; children?: Array<Node | string> | null };
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
const item: DecisionView = { id: "d1", project: "demo_tasks", title: "XYZ_0017 Release scope", detail: "A Release;B Waiting . demo fixture A",
  blocking: true, status: "open", createdAt: "2026-10-01T00:00:00Z", agentId: "specific-leader",
  leader: { agentId: "specific-leader", reason: null } };
const task = { code: "XYZ_0017", project: "demo_tasks", status: "blocked", blockedReason: "Wait for release scope", nextStep: null,
  returnNote: null, unattended: false, stallNote: null };
async function render(content: (s: Styles) => React.ReactNode) {
  const { View } = await import("react-native");
  function Harness() { return React.createElement(View, null, content(useStyles(theme, layout, DEFAULT_PANEL_PREFS, true))); }
  return await act(async () => TestRenderer.create(React.createElement(Harness))) as unknown as { toJSON(): Node | null; unmount(): void };
}
async function press(renderer: { toJSON(): Node | null }, label: string) {
  const button = nodes(renderer.toJSON(), (n) => n.type === "Pressable" && n.props?.accessibilityLabel === label)[0];
  assert.ok(button, `missing button ${label}`);
  assert.notEqual(button.props?.disabled, true);
  await act(async () => (button.props!.onPress as () => void)());
}

describe("decision UI", () => {
  it("hides an empty list and shows a read failure", async () => {
    for (const message of [null, zhCN("decisions.readFailed")]) {
      const renderer = await render((s) => React.createElement(DecisionsPanel, { s, snapshot: { items: [], message }, openAgent() {} }));
      assert.equal(textOf(renderer.toJSON()), message ?? "");
      await act(async () => renderer.unmount());
    }
  });
  it("expands the A/B detail and sends the chosen agent through the supplied opener", async () => {
    const opened: string[] = [];
    const renderer = await render((s) => React.createElement(DecisionsPanel, { s, snapshot: { items: [item], message: null }, openAgent: (id) => opened.push(id) }));
    assert.ok(textOf(renderer.toJSON()).includes(((zhCN("boardView.attention.decision") + " ") + "1")));
    assert.ok(textOf(renderer.toJSON()).includes(zhCN("decisions.row.blocking")));
    assert.ok(!textOf(renderer.toJSON()).includes(item.detail));
    const expand = nodes(renderer.toJSON(), (n) => n.props?.accessibilityLabel === `${zhCNPart("decisions.row.options", 0, 7)}${item.title}`)[0];
    await act(async () => (expand.props!.onPress as () => void)());
    assert.ok(textOf(renderer.toJSON()).includes(item.detail));
    await press(renderer, `${zhCN("decisions.row.goLeader")} · ${item.title}`);
    assert.deepEqual(opened, ["specific-leader"]);
    await act(async () => renderer.unmount());
  });
  it("shows owner, age and the newest note, and lists every note when expanded", async () => {
    const rich: DecisionView = { ...item, owner: "demo_tasks <leader>", userComments: [
      { at: "2026-10-01T01:00:00Z", note: "Old addition OLD-NOTE" }, { at: "2026-10-02T01:00:00Z", note: "New addition NEW-NOTE" }] };
    const renderer = await render((s) => React.createElement(DecisionsPanel, { s, snapshot: { items: [rich], message: null }, openAgent() {} }));
    const text = textOf(renderer.toJSON());
    assert.ok(text.includes((zhCNPart("decisions.row.meta", 12, 15) + "demo_tasks <leader>")));
    assert.ok(text.includes(zhCNPart("decisions.row.meta", 25, 27)));
    assert.ok(text.includes("NEW-NOTE") && !text.includes("OLD-NOTE"));
    const expand = nodes(renderer.toJSON(), (n) => n.props?.accessibilityLabel === `${zhCNPart("decisions.row.options", 0, 7)}${item.title}`)[0];
    await act(async () => (expand.props!.onPress as () => void)());
    assert.ok(textOf(renderer.toJSON()).includes("OLD-NOTE") && textOf(renderer.toJSON()).includes("NEW-NOTE"));
    await act(async () => renderer.unmount());
  });
  it("falls back to the project leader when the decision has no owner", async () => {
    const renderer = await render((s) => React.createElement(DecisionsPanel, { s, snapshot: { items: [item], message: null }, openAgent() {} }));
    assert.ok(textOf(renderer.toJSON()).includes((zhCNPart("decisions.row.meta", 12, 15) + "demo_tasks <leader>")));
    await act(async () => renderer.unmount());
  });
  it("main tap opens the card named in the decision, even one the board has not loaded", async () => {
    const cards: number[] = []; const agents: string[] = []; const asked: string[] = [];
    const two = { ...item, title: "XYZ_0099 sample XYZ_0017 Release scope" };
    const renderer = await render((s) => React.createElement(DecisionsPanel, {
      s, snapshot: { items: [two], message: null }, openAgent: (id) => agents.push(id),
      resolveCard: async (code) => { asked.push(code); return code === "XYZ_0099" ? { id: 99, message: null } : { id: 17, message: null }; },
      onOpenCard: (id) => cards.push(id) }));
    await press(renderer, `${zhCNPart("decisions.row.open", 0, 5)}${two.title}`);
    assert.deepEqual(cards, [99]);
    assert.deepEqual(agents, []);
    assert.ok(!textOf(renderer.toJSON()).includes(item.detail), "tapping does not just expand");
    await press(renderer, `${zhCNPart("decisions.row.openCodeLabel", 0, 4)}XYZ_0017 · ${two.title}`);
    assert.deepEqual(cards, [99, 17]);
    await act(async () => renderer.unmount());
  });
  it("main tap skips a card that does not exist, says so, and falls back to the leader", async () => {
    const cards: number[] = []; const agents: string[] = [];
    const renderer = await render((s) => React.createElement(DecisionsPanel, {
      s, snapshot: { items: [item], message: null }, openAgent: (id) => agents.push(id),
      resolveCard: async () => ({ id: null, message: zhCN("cardRef.error.noCard", {"card":"XYZ_0017"}) }), onOpenCard: (id) => cards.push(id) }));
    await press(renderer, `${zhCNPart("decisions.row.open", 0, 5)}${item.title}`);
    assert.deepEqual(cards, []);
    assert.deepEqual(agents, ["specific-leader"]);
    assert.ok(textOf(renderer.toJSON()).includes(zhCN("cardRef.error.noCard", {"card":"XYZ_0017"})));
    await act(async () => renderer.unmount());
  });
  it("main tap without a card number opens the leader; without a usable leader it expands the full text", async () => {
    const plain = { ...item, title: "Release scope", detail: "demo fixture Documentation FULL-TEXT" };
    const agents: string[] = [];
    const renderer = await render((s) => React.createElement(DecisionsPanel, { s, snapshot: { items: [plain], message: null }, openAgent: (id) => agents.push(id) }));
    await press(renderer, `${zhCNPart("decisions.row.open", 0, 5)}${plain.title}`);
    assert.deepEqual(agents, ["specific-leader"]);
    await act(async () => renderer.unmount());
    const gone = { ...plain, leader: { agentId: null, reason: zhCN("decisions.leader.archived") } };
    const second = await render((s) => React.createElement(DecisionsPanel, { s, snapshot: { items: [gone], message: null }, openAgent: (id) => agents.push(id) }));
    await press(second, `${zhCNPart("decisions.row.open", 0, 5)}${plain.title}`);
    assert.deepEqual(agents, ["specific-leader"]);
    assert.ok(textOf(second.toJSON()).includes("FULL-TEXT"));
    await act(async () => second.unmount());
  });
  it("disables decision, badge and leader buttons with a visible explanation", async () => {
    const missing = { agentId: null, reason: zhCN("decisions.leader.archived") };
    let opened = 0;
    const renderer = await render((s) => React.createElement(React.Fragment, null,
      React.createElement(DecisionsPanel, { s, snapshot: { items: [{ ...item, leader: missing }], message: null }, openAgent() { opened++; } }),
      React.createElement(CardAttention, { s, task, decisions: [{ ...item, leader: missing }], leader: missing, openAgent() { opened++; } })));
    const links = nodes(renderer.toJSON(), (n) => n.type === "Pressable" && new RegExp(localePattern(zhCNPart("decisions.row.goLeader", 0, 10)) + "|" + zhCN("decisions.card.findLeader") + "|" + localePattern(zhCNPart("decisions.card.goLeader", 7, 13))).test(String(n.props?.accessibilityLabel)));
    assert.equal(links.length, 3);
    for (const link of links) {
      assert.equal(link.props?.disabled, true);
      assert.deepEqual(link.props?.accessibilityState, { disabled: true });
      assert.equal(link.props?.onPress, undefined);
    }
    assert.ok(textOf(renderer.toJSON()).includes(missing.reason));
    assert.ok(textOf(renderer.toJSON()).includes(zhCN("boardView.blocked.where", {"reason":"Wait for release scope"})));
    assert.equal(opened, 0);
    await act(async () => renderer.unmount());
  });
  it("keeps badge and project leader navigation separate, and renders counts", async () => {
    const opened: string[] = [];
    const renderer = await render((s) => React.createElement(React.Fragment, null,
      React.createElement(CardAttention, { s, task, decisions: [item], leader: { agentId: "project-leader", reason: null }, openAgent: (id) => opened.push(id) }),
      React.createElement(ProjectAttention, { s, tasks: [task, { project: "demo_tasks", status: "acceptance" }], decisions: [item], unreadable: false })));
    const badge = nodes(renderer.toJSON(), (n) => n.props?.accessibilityLabel === zhCN("decisions.card.goLeader", {"code":"XYZ_0017"}))[0];
    await act(async () => (badge.props!.onPress as () => void)());
    await press(renderer, (zhCN("decisions.card.findLeader") + " · XYZ_0017"));
    assert.deepEqual(opened, ["specific-leader", "project-leader"]);
    assert.ok(textOf(renderer.toJSON()).includes(zhCN("decisions.project.totals", {"project":"demo_tasks","acceptance":"1","blocked":"1","decisions":"1"})));
    await act(async () => renderer.unmount());
  });
});

describe("board RPC navigation integration", () => {
  it("opens decisions and cards in the owning client without invoking the desktop opener", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const opened: unknown[] = [];
    const blocked = boardCard({ id: 17, status: "blocked", blockedReason: "Wait for release scope", blockedKind: "needs_human", column: "todo", badge: zhCN("labels.status.blocked"), related: ("demo_tasks · " + zhCNPart("boardView.drag", 0, 3) + "3 " + zhCNPart("missingCwd.purge.notThisCard", 4, 5)) });
    const running = boardCard({ id: 18, code: "XYZ_0018", related: ("demo_tasks · " + zhCNPart("boardView.drag", 0, 3) + "3 " + zhCNPart("missingCwd.purge.notThisCard", 4, 5)) });
    const board = boardSnapshot([blocked, running], [item]);
    const client = trackClient(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
    client.setQueryData(["kanban", "board", ""], board);
    client.setQueryData(["kanban", "prefs"], { ...DEFAULT_PANEL_PREFS, notice: null });
    client.setQueryData(["kanban", "board-tab"], { tab: "overview" });
    const invoke = async (method: string, input: unknown) => {
      calls.push({ method, input });
      if (method === "kanban.board") return board;
      if (method === "kanban.panel-prefs") return { ...DEFAULT_PANEL_PREFS, notice: null };
      if (method === "kanban.board-tab") return { tab: "overview" };
      if (method === "kanban.task") return taskDetail(blocked);
      if (method === "kanban.agent-link") return { url: "paseo://h/test/workspace/demo", message: "" };
      throw new Error(`unexpected RPC ${method}`);
    };
    const renderer = await act(async () => TestRenderer.create(React.createElement(QueryClientProvider, { client },
      React.createElement(PluginRpcProvider, { invoke, children: React.createElement(KanbanBoard, { theme, layout, host: { id: "test", label: "Test" }, navigation: { openAgent(input) { opened.push(input); }, openWorkspace() {} } }) })))) as unknown as { toJSON(): Node | null; unmount(): void };
    const cardNodes = nodes(renderer.toJSON(), n => n.props?.testID === "kanban-card");
    assert.equal(cardNodes.length, 2);
    const hintOf = (card: Node) => String(nodes(card, (n) => n.props?.testID === "card-status")[0]!.props!.accessibilityLabel);
    assert.ok(hintOf(cardNodes[0]!).includes((zhCNPart("cardParts.alert.blocked", 0, 3) + "Wait for release scope")));
    assert.ok(hintOf(cardNodes[1]!).includes(zhCN("boardView.drag", {"count":"3"})));
    assert.ok(!textOf(renderer.toJSON()).includes((zhCNPart("settings.thresholds.archiveVerifyMs", 4, 6) + "Release scope")), "five facts stay off the compact card");
    await press(renderer, (zhCNPart("decisions.card.goLeader", 7, 12) + "1 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)));
    await press(renderer, `${zhCN("decisions.row.goLeader")} · ${item.title}`);
    await press(renderer, (zhCN("boardView.tab.overview") + zhCN("common.comma") + "2 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)));
    await press(renderer, zhCN("compactCard.a11y.open", {"code":"XYZ_0017","title":"Release"}));
    assert.ok(nodes(renderer.toJSON(), (n) => n.props?.testID === "card-drawer").length === 1);
    await settle();
    const badge = nodes(renderer.toJSON(), (n) => n.props?.accessibilityLabel === zhCN("decisions.card.goLeader", {"code":"XYZ_0017"}))[0];
    await act(async () => (badge.props!.onPress as () => void)());
    await press(renderer, (zhCN("decisions.card.findLeader") + " · XYZ_0017"));
    await settle();
    assert.equal(calls.filter((call) => call.method === "kanban.open-agent").length, 0);
    assert.deepEqual(opened, [
      { agentId: "specific-leader", serverId: "test" },
      { agentId: "specific-leader", serverId: "test" },
      { agentId: "project-leader", serverId: "test" },
    ]);
    await act(async () => renderer.unmount());
    client.clear();
  });
});
