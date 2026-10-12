import { DARK_THEME } from "./helpers/theme-fixture";
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { register } from "node:module";
import { it } from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import type { Layout, Theme } from "../client/ui";
import { DEFAULT_PANEL_PREFS } from "../shared/panel-prefs";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { CompactCard } = await import("../client/compact-card");
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

for (const status of ["in_review", "acceptance"]) {
  for (const nextStep of [(zhCN("blocked.prefix.external") + "CI"), (zhCNPart("identityLines.openExecutor", 2, 5) + zhCNPart("transientRetry.timeout.send", 4, 6)), null]) {
    it(`renders ${status} ${nextStep ?? "without a wait"} on the actual card face`, async () => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      function Harness() {
        const s = useStyles(DARK_THEME,
          { compact: true, platform: "web" } as unknown as Layout, DEFAULT_PANEL_PREFS, true);
        return React.createElement(CompactCard, {
          s, onOpen() {},
          task: { id: 1, code: "TEST_0107", title: "External wait", project: "demo_board", status,
            badge: zhCN("labels.status.inReview"), column: "doing", related: ("demo_board · " + zhCNPart("boardView.drag", 0, 3) + "0 " + zhCNPart("missingCwd.purge.notThisCard", 4, 5)), acceptanceMissing: false, returnNote: null,
            awaitingMerge: false, unattended: false, reviewRound: 0, roleLabel: zhCN("labels.role.executor"), blockedReason: null,
            blockedKind: null, tempNote: null, mcpNote: null, stallNote: null, nextStep },
        });
      }
      let renderer: { toJSON(): unknown; unmount(): void };
      await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)) as unknown as typeof renderer; });
      const body = textOf(renderer!.toJSON() as Node);
      const hintText = String(find(renderer!.toJSON() as Node, "card-status")?.props?.accessibilityLabel);
      assert.equal(body.includes((zhCN("blocked.prefix.external") + "CI")), false, "the face keeps no hint line");
      assert.equal(hintText.includes((zhCN("blocked.prefix.external") + "CI")), nextStep === (zhCN("blocked.prefix.external") + "CI"));
      assert.equal(hintText.includes(zhCN("blocked.nextStep", {"step":zhCN("boardView.external.headline")})), false);
      assert.equal(hintText.includes(zhCN("blocked.nextStep", {"step":(zhCNPart("identityLines.openExecutor", 2, 5) + zhCNPart("transientRetry.timeout.send", 4, 6))})), nextStep === (zhCNPart("identityLines.openExecutor", 2, 5) + zhCNPart("transientRetry.timeout.send", 4, 6)));
      assert.equal(hintText.includes(zhCNPart("cardParts.alert.blocked", 0, 3)), false);
      await act(async () => renderer!.unmount());
    });
  }
}
