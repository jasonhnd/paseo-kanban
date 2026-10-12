import { createRequire } from "node:module";
import ts from "typescript";
const normalizeColor = createRequire(import.meta.url)("@react-native/normalize-colors");
const colorProperty = /(?:color|background|fill|stroke|shadow|outline|tint)$/i;

/** Inspect literals, not comments or parsing regexes. Tone ids are semantic strings, not paint. */
export function colorLiterals(source: string): string[] {
  const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const constants = new Map<string, ts.Expression>();
  const index = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, index);
  };
  index(file);
  const visit = (node: ts.Node, paint = false, resolving = new Set<string>()) => {
    const name = ts.isPropertyAssignment(node) || ts.isJsxAttribute(node) || ts.isVariableDeclaration(node) ? node.name?.getText(file).replace(/["']/g, "") : "";
    const isPaint = paint || colorProperty.test(name ?? "");
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const value = node.text.trim();
      const numeric = /^#[\da-f]{3,8}$/i.test(value) || /(?:gradient\([^)]*)#[\da-f]{3,8}(?![\w])/i.test(value) || /\b(?:rgba?|hsla?|hwb|(?:ok)?l(?:ab|ch)|color)\(\s*(?:[\d.+-]|$)/i.test(value) && (isPaint || !ts.isTemplateHead(node));
      const named = normalizeColor(value) !== null && (isPaint || !["red", "green", "yellow", "blue"].includes(value));
      if (numeric || named) found.push(value);
    }
    if (isPaint && ts.isIdentifier(node) && constants.has(node.text) && !resolving.has(node.text)) {
      visit(constants.get(node.text)!, true, new Set([...resolving, node.text]));
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.condition, false, resolving);
      visit(node.whenTrue, isPaint, resolving);
      visit(node.whenFalse, isPaint, resolving);
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      visit(node.expression, isPaint, resolving);
      visit(node.argumentExpression, false, resolving);
      return;
    }
    if (ts.isCallExpression(node) || (ts.isBinaryExpression(node) && /^(?:===?|!==?)$/.test(node.operatorToken.getText(file)))) {
      ts.forEachChild(node, child => visit(child, false, resolving));
      return;
    }
    ts.forEachChild(node, child => visit(child, isPaint, resolving));
  };
  visit(file);
  return [...new Set(found)];
}
