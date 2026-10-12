import { DARK_THEME } from "./helpers/theme-fixture";
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import type { Layout, Theme } from "../client/ui";
import { DEFAULT_PANEL_PREFS } from "../shared/panel-prefs";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { CompactCard, badgeFace, SHORT_REASON_CHARS } = await import("../client/compact-card");
const { shouldStackColumns } = await import("../client/board-views");
const { useStyles } = await import("../client/ui");

type Node = { props?: Record<string, unknown>; children?: Array<Node | string> | null };
function find(node: Node | string | null, id: string): Node | null {
  if (!node || typeof node === "string") return null;
  if (node.props?.testID === id) return node;
  for (const child of node.children ?? []) { const hit = find(child, id); if (hit) return hit; }
  return null;
}
function textOf(node: Node | string | null): string {
  return typeof node === "string" ? node : (node?.children ?? []).map(textOf).join("");
}

describe("narrow board layout", () => {
  it("stacks the columns at 768 and keeps three at 1024 and 1440", () => {
    assert.equal(shouldStackColumns(768 - 56), true);
    assert.equal(shouldStackColumns(375 - 32), true);
    assert.equal(shouldStackColumns(1024 - 56), false);
    assert.equal(shouldStackColumns(1440 - 56), false);
  });

  it("prints only dependency on the badge, keeping the card numbers out of the face", () => {
    assert.equal(badgeFace(zhCN("labels.badge.waitingParents", {"marks":"DEMO_0073、XYZ_0119"})), zhCN("labels.badge.waitingParentsBare"));
    assert.equal(badgeFace(zhCN("labels.badge.waitingParentsBare")), zhCN("labels.badge.waitingParentsBare"));
    assert.equal(badgeFace(zhCN("labels.status.running")), zhCN("labels.status.running"));
  });

  async function render(badge: string, note?: { tone: "danger"; text: string }) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    function Harness() {
      const s = useStyles(DARK_THEME, { compact: true, platform: "web" } as unknown as Layout, DEFAULT_PANEL_PREFS, true);
      return React.createElement(CompactCard, {
        s, onOpen() {}, note,
        task: { id: 1, code: "TEST_0178", title: ("【" + zhCN("labels.role.executor") + "】" + zhCN("client.panel.title") + "Demo text"), project: "demo_board", status: "waiting", badge, column: "todo",
          related: "", acceptanceMissing: false, returnNote: null, awaitingMerge: false, unattended: false, reviewRound: 0,
          roleLabel: zhCN("labels.role.executor"), blockedReason: null, blockedKind: null, tempNote: null, mcpNote: null, stallNote: null, nextStep: null },
      });
    }
    let renderer: { toJSON(): unknown; unmount(): void };
    await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)) as unknown as typeof renderer; });
    return renderer!;
  }

  it("shows dependency on the face but keeps the full badge for the reader", async () => {
    const renderer = await render(zhCN("labels.badge.waitingParents", {"marks":"DEMO_0073、XYZ_0119"}));
    const tree = renderer.toJSON() as Node;
    assert.equal(textOf(find(tree, "card-status")), zhCN("labels.badge.waitingParentsBare"));
    assert.equal(find(tree, "card-status")?.props?.accessibilityLabel, zhCN("labels.badge.waitingParents", {"marks":"DEMO_0073、XYZ_0119"}));
    assert.equal(find(tree, "card-title") !== null, true);
    await act(async () => renderer.unmount());
  });

  it("does not cut a reason of six characters or fewer, and still cuts longer ones", async () => {
    const short = await render(zhCN("labels.status.done"), { tone: "danger", text: zhCN("boardView.attention.decision") });
    const shortStyle = ([] as unknown[]).concat(find(short.toJSON() as Node, "card-reason")?.props?.style as unknown).flat();
    assert.equal(shortStyle.some((item) => (item as { maxWidth?: string })?.maxWidth === "55%"), false);
    assert.equal(zhCN("boardView.attention.decision").length <= SHORT_REASON_CHARS, true);
    await act(async () => short.unmount());

    const long = await render(zhCN("labels.status.done"), { tone: "danger", text: (zhCNPart("cardParts.alert.blocked", 0, 3) + zhCNPart("tools.action.waitUser", 1, 4) + zhCNPart("settings.thresholds.loginBlipRetryMs", 0, 2) + "Demo text") });
    const longStyle = ([] as unknown[]).concat(find(long.toJSON() as Node, "card-reason")?.props?.style as unknown).flat();
    assert.equal(longStyle.some((item) => (item as { maxWidth?: string })?.maxWidth === "55%"), true);
    await act(async () => long.unmount());
  });
});
