import assert from "node:assert/strict";
import { register } from "node:module";
import { it } from "node:test";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { setLanguage } from "../shared/i18n";
import { DEFAULT_PANEL_PREFS } from "../shared/panel-prefs";
import type { Layout } from "../client/ui";
import { boardCard } from "./helpers/board-fixture";
import { DARK_THEME } from "./helpers/theme-fixture";
register(new URL("./rn-hooks.mjs", import.meta.url));
const { useStyles } = await import("../client/ui");
const { CompactCard } = await import("../client/compact-card");
const { FiveFacts } = await import("../client/card-parts");

for (const reviewStatus of ["Review scheduled: DEMO_0007 (automatic)", "Review in progress: DEMO_0009 (Independent reviewer)"]) {
  it(`renders the review assignment on the board card and in drawer facts: ${reviewStatus}`, async () => {
    setLanguage("en");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const task = boardCard({ reviewStatus });
    function Harness() {
      const s = useStyles(DARK_THEME, { compact: true, platform: "web" } as unknown as Layout, DEFAULT_PANEL_PREFS, true);
      return React.createElement(React.Fragment, null,
        React.createElement(CompactCard, { s, task, onOpen() {} }),
        React.createElement(FiveFacts, { s, task }));
    }
    let renderer!: ReturnType<typeof TestRenderer.create>;
    await act(async () => { renderer = TestRenderer.create(React.createElement(Harness)); });
    const nodes: Array<{ props: Record<string, unknown>; children?: unknown[] }> = [];
    function walk(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== "object") return;
      const node = value as { props?: Record<string, unknown>; children?: unknown[] };
      if (node.props?.testID === "card-review-status") nodes.push({ props: node.props, children: node.children });
      node.children?.forEach(walk);
    }
    walk(renderer.toJSON());
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].children?.join(""), reviewStatus);
    assert.equal(nodes[0].props.numberOfLines, undefined);
    const rendered = JSON.stringify(renderer.toJSON());
    assert.ok(rendered.includes("Review assignment"));
    assert.ok(rendered.split(reviewStatus).length >= 3, "board and drawer both show the assignment");
  });
}
