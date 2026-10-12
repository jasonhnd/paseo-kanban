/// <reference types="node" />
import assert from "node:assert/strict";
import "./helpers/window-stub";
import { register } from "node:module";
import { describe, it } from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "../node_modules/@getpaseo/plugin/dist/client/rpc-context.js";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { paletteFromTheme } from "../shared/palette";
import { t } from "../shared/i18n";
import { boardTabLabel } from "../shared/board-view";
import { boardCard, boardSnapshot, taskDetail } from "./helpers/board-fixture";
import { DARK_THEME, LIGHT_THEME } from "./helpers/theme-fixture";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { KanbanBoard } = await import("../client/board");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Node = { type?: string; props?: Record<string, unknown>; children?: Array<Node | string> | null };
type Renderer = { toJSON(): Node | null; update(element: React.ReactElement): void; unmount(): void };
function nodes(tree: Node | string | null): Node[] {
  return !tree || typeof tree === "string" ? [] : [tree, ...(tree.children ?? []).flatMap(nodes)];
}
function colors(tree: Node | null): Set<string> {
  const result = new Set<string>();
  function visit(value: unknown, key = "") {
    if (Array.isArray(value)) { value.forEach((v) => visit(v, key)); return; }
    if (typeof value === "object" && value !== null) { Object.entries(value).forEach(([k, v]) => visit(v, k)); return; }
    if (/color$/i.test(key) && typeof value === "string") result.add(value);
  }
  for (const n of nodes(tree)) visit(n.props);
  return result;
}
async function until(ready: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, "mounted board did not settle");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}

describe("mounted board theme props", () => {
  for (const platform of ["web", "ios"] as const) for (const lockedProject of [undefined, "demo_tasks"]) {
    it(`recolors the ${lockedProject ? "project" : "global"} ${platform} board and open drawer without resetting state`, async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const card = boardCard({ status: "blocked", blockedReason: "Confirm scope", blockedKind: "needs_human", column: "doing" });
      const snapshot = boardSnapshot([card]);
      const invoke = async (method: string) => {
        if (method === "kanban.board") return snapshot;
        if (method === "kanban.decisions") return { decisions: snapshot.decisions, leaders: snapshot.leaders, readAt: new Date().toISOString() };
        // A legacy saved override must never change the supplied host theme.
        if (method === "kanban.panel-prefs") return { fontStep: "md", colorMode: "light", notice: null };
        if (method === "kanban.board-tab") return { tab: "overview" };
        if (method === "kanban.task") return taskDetail(card);
        if (method === "kanban.config.read") return { language: "zh-CN" };
        if (method === "kanban.agents") return { items: [] };
        throw new Error(`unexpected RPC ${method}`);
      };
      const element = (theme: PluginSurfaceProps["theme"]) => React.createElement(QueryClientProvider, { client },
        React.createElement(PluginRpcProvider, { invoke, children: React.createElement(KanbanBoard, {
          theme, layout: { compact: platform !== "web", platform }, host: { id: "theme-test", label: "Demo" }, lockedProject,
          refresh: { boardMs: 60000, decisionsMs: 60000 },
        }) }));
      const renderer = await act(async () => TestRenderer.create(element(LIGHT_THEME))) as unknown as Renderer;
      try {
        await until(() => nodes(renderer.toJSON()).some((n) => n.props?.testID === "kanban-card"));
        const open = nodes(renderer.toJSON()).find((n) => n.props?.testID === "kanban-card")!;
        await act(async () => (open.props!.onPress as () => void)());
        await until(() => JSON.stringify(renderer.toJSON()).includes("BRIEF-FULL-TEXT"));
        const lightColors = colors(renderer.toJSON());
        assert.ok(lightColors.size > 10, "surfaces, text, borders, status badges and overlay are mounted");
        for (const color of lightColors) assert.ok(Object.values(paletteFromTheme(LIGHT_THEME)).includes(color), `light render used ${color}`);
        await act(async () => renderer.update(element(DARK_THEME)));
        assert.ok(JSON.stringify(renderer.toJSON()).includes("BRIEF-FULL-TEXT"), "drawer remains open in the same mount");
        const darkColors = colors(renderer.toJSON());
        for (const color of darkColors) {
          assert.ok(Object.values(paletteFromTheme(DARK_THEME)).includes(color), `dark render used ${color}`);
          assert.ok(!lightColors.has(color), `stale light color ${color}`);
        }
        const close = nodes(renderer.toJSON()).find((n) => n.props?.accessibilityLabel === t("cardDrawer.close.label"));
        assert.ok(close);
        await act(async () => (close.props!.onPress as () => void)());
        const settings = nodes(renderer.toJSON()).find((n) => n.props?.accessibilityLabel === boardTabLabel("settings"));
        assert.ok(settings);
        await act(async () => (settings.props!.onPress as () => void)());
        await act(async () => renderer.update(element(LIGHT_THEME)));
        for (const color of colors(renderer.toJSON())) assert.ok(Object.values(paletteFromTheme(LIGHT_THEME)).includes(color), `settings render used ${color}`);
        const text = JSON.stringify(renderer.toJSON());
        assert.ok(!text.includes("Color mode"));
      } finally {
        await act(async () => renderer.unmount());
        client.clear();
      }
    });
  }
});
