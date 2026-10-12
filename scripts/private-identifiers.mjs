// A privacy exception is a resolved local binding in one named function/file, never a word allowlist.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function identifierSpans(path, text, exceptions, privateRules) {
  const policies = exceptions.filter(item => item.path.test(path)
    && privateRules.some(rule => item.term.match(rule.pattern)));
  const spans = new Set();
  if (!policies.length) return spans;
  // Publication/contributor tooling requires the locked TypeScript parser. Missing it is a setup failure.
  const ts = require("typescript");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length) return spans;
  const host = {
    getSourceFile: name => name === path ? file : undefined,
    getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => "",
    getDirectories: () => [], fileExists: name => name === path,
    readFile: name => name === path ? text : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  };
  const program = ts.createProgram([path], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const symbols = new Set();
  const nodes = [];
  function visit(node) {
    if (ts.isIdentifier(node)) nodes.push(node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) {
      let owner = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (owner && ts.isFunctionDeclaration(owner) && owner.name
          && policies.some(item => node.name.text === item.term && owner.name.text === item.function)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) symbols.add(symbol);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const node of nodes) {
    const parent = node.parent;
    // Even a shorthand property publishes a name; property/member names are never local-variable uses.
    if (ts.isShorthandPropertyAssignment(parent)
        || (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node)) continue;
    if (!symbols.has(checker.getSymbolAtLocation(node))) continue;
    spans.add(`${node.getStart(file)}:${node.getWidth(file)}`);
  }
  return spans;
}
