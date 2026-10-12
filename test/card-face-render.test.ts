import { DARK_THEME } from "./helpers/theme-fixture";
/// <reference types="node" />
import { zhCN, zhCNPart, localePattern } from "./helpers/locale";
import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import React, { act, useState } from "react";
import TestRenderer from "react-test-renderer";
import type { Layout, Styles, Theme } from "../client/ui";
import type { IdentityLines } from "../client/identity-lines";
import type { PanelPrefsControls } from "../client/prefs-controls";
import { DEFAULT_PANEL_PREFS, type PanelPrefs } from "../shared/panel-prefs";

register(new URL("./rn-hooks.mjs", import.meta.url));

const ui = (await import("../client/ui")) as typeof import("../client/ui");
const identity = (await import("../client/identity-lines")) as { IdentityLines: typeof IdentityLines };
const prefs = (await import("../client/prefs-controls")) as { PanelPrefsControls: typeof PanelPrefsControls };

type Node = {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string> | null;
};

function walk(node: Node | string | null | undefined, visit: (node: Node) => void) {
  if (!node || typeof node === "string") return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function textOf(node: Node | string | null): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map((child) => textOf(child)).join("");
}

describe("card footer render", () => {
  it("wraps a long current line on a narrow row and keeps both agent presses", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const current = ((zhCN("labels.role.executor") + " ") + "· " + (zhCN("labels.role.executor") + " ") + "· Cursor " + zhCNPart("worktreeGc.branch.localGone", 0, 2) + zhCNPart("missingCwd.none", 0, 1) + zhCNPart("nativeSessions.sweep.progressChecked", 23, 25) + zhCNPart("missingCwd.none", 3, 4) + " · grok-4.7 · high · agent 74fe0238");
    const executor = ((zhCN("labels.role.executor") + " ") + "· Opus · agent abcdef12");
    const opened: string[] = [];
    const bag: { styles?: Styles } = {};
    function FooterHarness() {
      const s = ui.useStyles(
        DARK_THEME,
        { compact: true, platform: "web" } as unknown as Layout,
        DEFAULT_PANEL_PREFS,
        true,
      );
      bag.styles = s;
      return React.createElement(identity.IdentityLines, {
        s,
        roleLabel: zhCN("labels.role.executor"),
        currentText: current,
        executorText: executor,
        agentId: "74fe0238-current",
        executorAgentId: "abcdef12-executor",
        startedAt: "2026-10-01T02:00:00.000Z",
        onOpen(id: string) {
          opened.push(id);
        },
      });
    }
    const renderer = await act(async () => TestRenderer.create(React.createElement(FooterHarness)) as { toJSON(): Node | null });
    const dumped = renderer.toJSON();
    if (!dumped) throw new Error("identity footer rendered nothing");
    const tree = dumped;
    const styles = bag.styles;
    if (!styles) throw new Error("styles were not built");
    assert.equal(tree.props?.style, styles.identity);
    const row = tree.props?.style as { flexDirection?: string; flexWrap?: string; maxWidth?: string; columnGap?: number };
    assert.equal(row.flexDirection, "row");
    assert.equal(row.flexWrap, "wrap");
    assert.equal(row.maxWidth, "100%");
    const body = textOf(tree);
    assert.match(body, new RegExp((zhCN("labels.identity.role") + " ") + zhCN("labels.role.executor")));
    assert.ok(body.includes(current));
    assert.ok(body.includes(executor));
    assert.match(body, new RegExp(zhCN("labels.identity.started") + " .+ · " + localePattern(zhCNPart("identityLines.started", 9, 13))));
    assert.equal(styles.identityText.fontSize < styles.factValue.fontSize, true);
    const presses: Node[] = [];
    walk(tree, (node) => {
      if (node.type === "Pressable") presses.push(node);
      if (node.type === "Text") assert.equal(node.props?.numberOfLines, undefined);
      const item = node.props?.style as { maxWidth?: string; minWidth?: number; flexShrink?: number } | undefined;
      if (node.type === "View" && node !== tree && item) {
        assert.equal(item.maxWidth, "100%");
        assert.equal(item.minWidth, 0);
        assert.equal(item.flexShrink, 1);
      }
      if (node.type === "Pressable") {
        assert.equal(item?.maxWidth, "100%");
        assert.equal(item?.minWidth, 0);
        assert.equal(item?.flexShrink, 1);
      }
    });
    assert.deepEqual(
      presses.map((node) => node.props?.accessibilityLabel),
      [zhCN("identityLines.openCurrent"), zhCN("identityLines.openExecutor")],
    );
    for (const node of presses) {
      const onPress = node.props?.onPress;
      assert.equal(typeof onPress, "function");
      (onPress as () => void)();
    }
    assert.deepEqual(opened, ["74fe0238-current", "abcdef12-executor"]);
  });
});

describe("prefs save notice", () => {
  it("shows the broken-file sentence and falls back to the saved defaults", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const notice = zhCN("panelPrefs.brokenBackedUp", {"backup":"panel-prefs.json.9.bak"});
    const seen: PanelPrefs[] = [];
    let finishSave: (saved: PanelPrefs & { notice: string | null }) => void = () => undefined;
    const pending = new Promise<PanelPrefs & { notice: string | null }>((resolve) => {
      finishSave = resolve;
    });

    function Harness() {
      const s = ui.useStyles(
        DARK_THEME,
        { compact: false, platform: "web" } as unknown as Layout,
        DEFAULT_PANEL_PREFS,
        false,
      );
      const [override, setOverride] = useState<PanelPrefs | null>(null);
      const [stored, setStored] = useState<PanelPrefs>(DEFAULT_PANEL_PREFS);
      const shown = override ?? stored;
      seen.push(shown);
      return React.createElement(prefs.PanelPrefsControls, {
        s,
        prefs: shown,
        save() {
          return pending;
        },
        onOptimistic: setOverride,
        onSettled(saved: PanelPrefs) {
          setStored(saved);
          setOverride(null);
        },
        onRevert() {
          setOverride(null);
        },
      });
    }

    const renderer = await act(async () => TestRenderer.create(React.createElement(Harness)) as { toJSON(): Node | null });
    const before = textOf(renderer.toJSON() as Node);
    assert.equal(before.includes(notice), false);
    let large: (() => void) | null = null;
    walk(renderer.toJSON() as Node, (node) => {
      if (node.props?.accessibilityLabel === (zhCN("prefsControls.font.label") + zhCN("common.colon") + zhCN("prefsControls.font.lg"))) large = node.props.onPress as () => void;
    });
    assert.equal(typeof large, "function");
    await act(async () => {
      large?.();
    });
    assert.equal(seen.at(-1)?.fontStep, "lg");
    assert.equal(textOf(renderer.toJSON() as Node).includes(notice), false);
    await act(async () => {
      finishSave({ ...DEFAULT_PANEL_PREFS, notice });
      await pending;
    });
    const after = textOf(renderer.toJSON() as Node);
    assert.ok(after.includes(notice));
    assert.equal(seen.at(-1)?.fontStep, "md");
    assert.deepEqual(seen.at(-1), { fontStep: "md" });
  });
});
