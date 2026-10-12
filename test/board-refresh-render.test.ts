import { DARK_THEME } from "./helpers/theme-fixture";
/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import "./helpers/window-stub";
import { register } from "node:module";
import { afterEach, describe, it } from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "../node_modules/@getpaseo/plugin/dist/client/rpc-context.js";
import { DEFAULT_PANEL_PREFS } from "../shared/panel-prefs";
import type { Layout, Theme } from "../client/ui";
import { boardCard, boardSnapshot, taskDetail } from "./helpers/board-fixture";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { KanbanBoard } = await import("../client/board");
const { AppState } = (await import("react-native")) as unknown as { AppState: { __emit(state: string): void } };
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
const byId = (renderer: Rendered, id: string) => nodes(renderer.toJSON(), (n) => n.props?.testID === id);
const theme = DARK_THEME;
const layout = { compact: true, platform: "web" } as Layout;
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
/** Longest any condition may take on a busy machine; a passing run never spends it. */
const WAIT_LIMIT_MS = 10_000;
/** Polls until `ready()`, so a slow machine only makes the test slower, not wrong. */
async function waitUntil(ready: () => boolean, what: string) {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > WAIT_LIMIT_MS) assert.fail(`timed out after ${Date.now() - started}ms waiting for ${what}`);
    await wait(5);
  }
}
let activeClient: QueryClient | undefined;
/** Waits until the first board read has landed and the skeleton is gone. */
const loaded = (renderer: Rendered) => waitUntil(() => byId(renderer, "board-skeleton").length === 0, "the board to finish loading");
async function press(renderer: Rendered, label: string) {
  const button = nodes(renderer.toJSON(), (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === "function")[0];
  assert.ok(button, `missing button ${label}`);
  await act(async () => (button.props!.onPress as () => void)());
  await wait(20);
  const client = activeClient;
  if (client) await waitUntil(() => client.isFetching() === 0, `reads to settle after pressing ${label}`);
}

type Handler = (input: unknown) => unknown;
interface MountOptions {
  board?: ReturnType<typeof boardSnapshot> | (() => ReturnType<typeof boardSnapshot>);
  handlers?: Record<string, Handler>;
  client?: QueryClient;
  refresh?: { boardMs: number; decisionsMs: number };
  tab?: string;
}
/** Every mounted board, so a failed test still unmounts it and stops its refresh timers (otherwise the process never exits). */
const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of open.splice(0)) await close(); });
async function mount(options: MountOptions = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const client = options.client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  activeClient = client;
  const snapshot = options.board ?? boardSnapshot([boardCard({})]);
  const invoke = async (method: string, input: unknown) => {
    calls.push({ method, input });
    const custom = options.handlers?.[method];
    if (custom) return custom(input);
    if (method === "kanban.board") return typeof snapshot === "function" ? snapshot() : snapshot;
    if (method === "kanban.decisions") { const board = typeof snapshot === "function" ? snapshot() : snapshot; return { decisions: board.decisions, leaders: board.leaders, readAt: new Date().toISOString() }; }
    if (method === "kanban.panel-prefs") return { ...DEFAULT_PANEL_PREFS, notice: null };
    if (method === "kanban.board-tab") return { tab: options.tab ?? "overview" };
    if (method === "kanban.history") return { total: 0, items: [] };
    if (method === "kanban.task") return taskDetail(boardCard({}));
    throw new Error(`unexpected RPC ${method}`);
  };
  const renderer = await act(async () => TestRenderer.create(React.createElement(QueryClientProvider, { client },
    React.createElement(PluginRpcProvider, { invoke, children: React.createElement(KanbanBoard, { theme, layout, host: { id: "t", label: "T" }, refresh: options.refresh, navigation: { openAgent() {}, openWorkspace() {} } }) })))) as unknown as Rendered;
  let closed = false;
  const done = async () => {
    if (closed) return;
    closed = true;
    await act(async () => renderer.unmount());
    client.clear();
  };
  open.push(done);
  return { renderer, calls, client, count: (method: string) => calls.filter((c) => c.method === method).length, done };
}

describe("card face: who, model, what, state", () => {
  it("shows sender and role, model, one-line title and the status badge on two lines", async () => {
    const m = await mount({ board: boardSnapshot([boardCard({ id: 1, code: "TEST_0001", title: "Fix login", assignerShort: "TEST <leader>", modelShort: "Claude Sonnet 5.5", roleLabel: zhCN("labels.role.executor"), badge: zhCN("labels.status.running"), status: "running" })]) });
    await loaded(m.renderer);
    const card = byId(m.renderer, "kanban-card")[0]!;
    assert.equal(textOf(byId(m.renderer, "card-dispatch")[0]!), ("demo_tasks · TEST <leader> " + zhCNPart("labels.model.unassigned", 1, 2) + " · " + (zhCN("labels.role.executor") + " ") + "· Claude Sonnet 5.5"));
    const body = textOf(card);
    assert.ok(body.includes("TEST_0001") && body.includes("Fix login") && body.includes(zhCN("labels.status.running")));
    assert.equal((card.children ?? []).length, 2, "exactly two lines");
    assert.ok(!body.includes(zhCNPart("boardView.drag", 0, 2)) && !body.includes(zhCNPart("blocked.nextStep", 0, 3)), "no extra hint line");
    await m.done();
  });

  it("shows unassigned before a card has started and the profile name when no model is known", async () => {
    const m = await mount({ board: boardSnapshot([
      boardCard({ id: 1, code: "TEST_0001", status: "ready", column: "todo", badge: zhCN("labels.status.ready"), modelShort: zhCN("labels.model.unassigned"), assignerShort: zhCN("labels.assigner.user") }),
      boardCard({ id: 2, code: "TEST_0002", modelShort: "Sample profile" }),
    ]) });
    await loaded(m.renderer);
    const lines = byId(m.renderer, "card-dispatch").map((n) => textOf(n));
    assert.deepEqual(lines, [("demo_tasks · " + zhCN("labels.assigner.user") + " " + zhCNPart("labels.model.unassigned", 1, 2) + " · " + (zhCN("labels.role.executor") + " ") + "· " + zhCN("labels.model.unassigned")), ("demo_tasks · " + zhCN("labels.assigner.user") + " " + zhCNPart("labels.model.unassigned", 1, 2) + " · " + (zhCN("labels.role.executor") + " ") + "· Sample profile")]);
    await m.done();
  });

  it("keeps a very long title on one truncated line", async () => {
    const long = "Long title".repeat(40);
    const m = await mount({ board: boardSnapshot([boardCard({ title: long })]) });
    await loaded(m.renderer);
    const title = nodes(m.renderer.toJSON(), (n) => n.type === "Text" && textOf(n) === long)[0]!;
    assert.equal(title.props?.numberOfLines, 1);
    await m.done();
  });

  it("falls back to unknown and unassigned when an older server sends no face fields", async () => {
    const m = await mount({ board: boardSnapshot([boardCard({ assignerShort: "", modelShort: "" })]) });
    await loaded(m.renderer);
    assert.equal(textOf(byId(m.renderer, "card-dispatch")[0]!), ("demo_tasks · " + zhCN("labels.assigner.unknown") + " " + zhCNPart("labels.model.unassigned", 1, 2) + " · " + (zhCN("labels.role.executor") + " ") + "· " + zhCN("labels.model.unassigned")));
    await m.done();
  });

  it("uses the same face in the attention tab and the by-project filter", async () => {
    const blocked = boardCard({ id: 2, code: "TEST_0002", status: "blocked", badge: zhCN("labels.status.blocked"), column: "todo", blockedReason: "Missing key", blockedKind: "needs_human", assignerShort: "Kanban <leader>", modelShort: "GPT-6.1-Sol" });
    const m = await mount({ board: boardSnapshot([blocked]), tab: "attention" });
    await loaded(m.renderer);
    assert.equal(textOf(byId(m.renderer, "card-dispatch-who")[0]!), ("Kanban <leader> " + zhCNPart("labels.model.unassigned", 1, 2)));
    assert.equal(textOf(byId(m.renderer, "card-dispatch-rolemodel")[0]!), (" · " + (zhCN("labels.role.executor") + " ") + "· GPT-6.1-Sol"));
    assert.equal(textOf(byId(m.renderer, "card-reason")[0]!), (zhCNPart("cardParts.alert.blocked", 0, 3) + "Missing key"));
    await m.done();
  });

  it("never cuts role or model: the sender segment shrinks, the role · model segment does not", async () => {
    const m = await mount({ board: boardSnapshot([boardCard({ project: "demo_fleet", assignerShort: "EX <leader>", modelShort: "Claude Sonnet 5.5" })]) });
    await loaded(m.renderer);
    const who = byId(m.renderer, "card-dispatch-who")[0]!;
    const model = byId(m.renderer, "card-dispatch-rolemodel")[0]!;
    assert.equal(textOf(model), (" · " + (zhCN("labels.role.executor") + " ") + "· Claude Sonnet 5.5"), "role sits in the segment that never shrinks");
    assert.equal(textOf(who), ("demo_fleet · EX <leader> " + zhCNPart("labels.model.unassigned", 1, 2)), "the sender segment carries no role");
    assert.equal(who.props?.numberOfLines, 1);
    assert.equal(model.props?.numberOfLines, undefined, "no ellipsis on the model");
    const flat = Object.assign({}, ...[model.props?.style].flat(3).filter(Boolean)) as { flexShrink?: number };
    assert.equal(flat.flexShrink, 0);
    const whoFlat = Object.assign({}, ...[who.props?.style].flat(3).filter(Boolean)) as { flexShrink?: number };
    assert.equal(whoFlat.flexShrink, 1);
    await m.done();
  });

  it("shows why a card is on the attention list as visible text, even when its badge says done", async () => {
    const item = { id: "d1", project: "demo_tasks", title: "TEST_0001 Decision needed", detail: "A", blocking: false, status: "open" as const, createdAt: "2026-10-03T00:00:00Z", agentId: null, leader: { agentId: "l", reason: null } };
    const done = boardCard({ id: 1, code: "TEST_0001", status: "done", badge: zhCN("labels.status.done"), column: "done" });
    const m = await mount({ board: boardSnapshot([done], [item]), tab: "attention" });
    await loaded(m.renderer);
    assert.equal(textOf(byId(m.renderer, "card-reason")[0]!), zhCN("boardView.attention.decision"));
    await m.done();
  });
});

describe("opening and staying fresh", () => {
  it("asks for the board, the prefs and the tab as soon as it mounts", async () => {
    const m = await mount();
    assert.ok(m.count("kanban.board") >= 1 && m.count("kanban.board-tab") >= 1 && m.count("kanban.panel-prefs") >= 1);
    await m.done();
  });

  it("re-reads on every reopen: shows the cached cards with sample, then the new data", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const old = boardSnapshot([boardCard({ id: 1, code: "TEST_0001", title: "Old title" })]);
    client.setQueryData(["kanban", "board", ""], old);
    client.setQueryData(["kanban", "prefs"], { ...DEFAULT_PANEL_PREFS, notice: null });
    client.setQueryData(["kanban", "board-tab"], { tab: "overview" });
    let release: (value: unknown) => void = () => undefined;
    const gate = new Promise((resolve) => { release = resolve; });
    const fresh = boardSnapshot([boardCard({ id: 1, code: "TEST_0001", title: "New title" })]);
    const m = await mount({ client, handlers: { "kanban.board": () => gate.then(() => fresh) } });
    assert.ok(textOf(m.renderer.toJSON()).includes("Old title"), "last data stays on screen, no blank page");
    assert.ok(textOf(m.renderer.toJSON()).includes(zhCNPart("board.refreshing", 0, 4)), "and says it is refreshing");
    assert.equal(m.count("kanban.board"), 1, "the mount asked for fresh data even though the cache had some");
    release(undefined);
    await waitUntil(() => textOf(m.renderer.toJSON()).includes("New title"), "the fresh title");
    assert.ok(textOf(m.renderer.toJSON()).includes("New title") && !textOf(m.renderer.toJSON()).includes("Old title"));
    assert.match(textOf(m.renderer.toJSON()), new RegExp(zhCN("board.updatedAt", {"time":"\\d\\d:\\d\\d:\\d\\d"})));
    assert.ok(!textOf(m.renderer.toJSON()).includes(zhCNPart("board.refreshing", 0, 4)));
    await m.done();
  });

  it("reads the board again on a timer while open", async () => {
    const m = await mount({ refresh: { boardMs: 40, decisionsMs: 40 } });
    await loaded(m.renderer);
    const before = m.count("kanban.board");
    await waitUntil(() => m.count("kanban.board") >= before + 2, "two timer reads of the board");
    assert.ok(m.count("kanban.board") >= before + 2, `expected timer reads, got ${m.count("kanban.board") - before}`);
    await m.done();
  });

  it("reads again when the app or page comes back to the foreground", async () => {
    const m = await mount();
    await loaded(m.renderer);
    const before = m.count("kanban.board");
    await act(async () => AppState.__emit("active"));
    await waitUntil(() => m.count("kanban.board") > before, "the foreground read");
    await wait(20);
    assert.equal(m.count("kanban.board"), before + 1);
    await m.done();
  });

  it("reads the decisions again each time the tab opens, and on its own timer", async () => {
    const m = await mount({ refresh: { boardMs: 10_000, decisionsMs: 40 } });
    await loaded(m.renderer);
    assert.equal(m.count("kanban.decisions"), 0, "not read while another tab is showing");
    await press(m.renderer, (zhCNPart("decisions.card.goLeader", 7, 12) + "0 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)));
    assert.ok(m.count("kanban.decisions") >= 1, "opening the tab reads at once");
    await waitUntil(() => m.count("kanban.decisions") >= 3, "two timer reads of the decisions");
    assert.ok(m.count("kanban.decisions") >= 3, `expected timer reads, got ${m.count("kanban.decisions")}`);
    await press(m.renderer, (zhCN("boardView.tab.overview") + zhCN("common.comma") + "1 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)));
    const left = m.count("kanban.decisions");
    await wait(200);
    assert.equal(m.count("kanban.decisions"), left, "stops polling when the tab is not showing");
    await press(m.renderer, (zhCNPart("decisions.card.goLeader", 7, 12) + "0 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)));
    await waitUntil(() => m.count("kanban.decisions") >= left + 1, "a read after switching back");
    await m.done();
  });

  it("shows a decision that appears between reads on the decisions tab", async () => {
    const item = { id: "d1", project: "demo_tasks", title: "New decision", detail: "A", blocking: false, status: "open" as const, createdAt: "2026-10-03T00:00:00Z", agentId: null, leader: { agentId: "l", reason: null } };
    let items: typeof item[] = [];
    const m = await mount({ board: () => boardSnapshot([boardCard({})], []), handlers: { "kanban.decisions": () => ({ decisions: { items, message: null }, leaders: {}, readAt: new Date().toISOString() }) }, refresh: { boardMs: 10_000, decisionsMs: 40 } });
    await loaded(m.renderer);
    await press(m.renderer, (zhCNPart("decisions.card.goLeader", 7, 12) + "0 " + zhCNPart("board.intake.projectPlaceholder", 0, 1)));
    assert.ok(textOf(m.renderer.toJSON()).includes(zhCNPart("board.noDecisions", 0, 8)));
    items = [item];
    await waitUntil(() => textOf(m.renderer.toJSON()).includes("New decision"), "the new decision");
    assert.ok(textOf(m.renderer.toJSON()).includes("New decision"));
    await m.done();
  });
});

describe("first paint", () => {
  it("renders a skeleton, never the overview columns, until the saved tab and data are in", async () => {
    const seen: Array<{ skeleton: boolean; columns: boolean; attention: boolean }> = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const m = await mount({
      tab: "attention",
      handlers: { "kanban.board-tab": () => gate.then(() => ({ tab: "attention" })) },
    });
    const snap = () => seen.push({ skeleton: byId(m.renderer, "board-skeleton").length > 0, columns: byId(m.renderer, "board-columns").length > 0, attention: byId(m.renderer, "attention-view").length > 0 });
    snap();
    assert.equal(seen[0]!.skeleton, true, "skeleton on the very first frame");
    release();
    await waitUntil(() => { snap(); return seen.at(-1)!.attention; }, "the saved attention tab");
    assert.ok(seen.every((frame) => !frame.columns), "the overview columns never appear on the way to the attention tab");
    assert.equal(seen.at(-1)!.attention, true);
    assert.equal(seen.at(-1)!.skeleton, false);
    await m.done();
  });

  it("shows tab names without counts while loading, and no old three-column list", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const m = await mount({ handlers: { "kanban.board": () => gate.then(() => boardSnapshot([boardCard({})])) } });
    await wait(10);
    assert.equal(byId(m.renderer, "board-columns").length, 0);
    assert.equal(byId(m.renderer, "board-skeleton").length, 1);
    const tabs = nodes(m.renderer.toJSON(), (n) => n.props?.accessibilityRole === "tab").map((n) => String(n.props!.accessibilityLabel));
    assert.deepEqual(tabs, [zhCN("boardView.tab.overview"), zhCN("boardView.tab.attention"), zhCN("boardView.attention.decision"), zhCN("boardView.tab.projects"), zhCN("boardView.tab.settings")]);
    release();
    await loaded(m.renderer);
    assert.equal(byId(m.renderer, "board-skeleton").length, 0);
    assert.equal(byId(m.renderer, "board-columns").length, 1);
    await m.done();
  });

  it("leaves no pre-tab entry points behind in the client bundle", async () => {
    const { readFileSync } = await import("node:fs");
    const entry = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
    assert.equal((entry.match(/addScreen\(/g) ?? []).length, 1, "one screen");
    // The panel goes through client/panel-title.ts, which can register it again when the language changes.
    assert.equal((entry.match(/registerBoardPanel\(/g) ?? []).length, 1, "one panel");
    const board = readFileSync(new URL("../client/board.tsx", import.meta.url), "utf8");
    assert.ok(!board.includes("CardFace"), "old card-face wrapper is gone");
  });
});
