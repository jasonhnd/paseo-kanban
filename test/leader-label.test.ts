/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import ts from "typescript";
import { describe, it } from "node:test";
import { LEADER_LABEL, roleLabel } from "../shared/labels";

function LeaderHeading() {
  return React.createElement("span", null, `Kanban ${roleLabel("supervisor")}${zhCNPart("settingsPanel.fallback.title", 15, 19)}`);
}

describe("leader label", () => {
  it("renders <leader> as text and does not turn it into an element", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    assert.equal(LEADER_LABEL, "<leader>");
    assert.equal(roleLabel("supervisor"), "<leader>");
    const renderer = await act(async () => TestRenderer.create(React.createElement(LeaderHeading)));
    const json = renderer.toJSON();
    assert.ok(json && typeof json !== "string");
    assert.equal(json.type, "span");
    assert.deepEqual(json.children, [zhCN("settingsPanel.fallback.title", {"leader":"<leader>"})]);
    assert.equal(JSON.stringify(json).includes('"type":"leader"'), false);
  });

  it("keeps the board from parsing <leader> as a JSX tag", () => {
    const path = "client/board.tsx";
    const source = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const tags: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxClosingElement(node)) {
        tags.push(node.tagName.getText(file));
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    assert.equal(tags.includes("leader"), false);
    assert.match(source, /LEADER_LABEL/);
    assert.equal(source.includes("<leader>"), false);
  });
});
