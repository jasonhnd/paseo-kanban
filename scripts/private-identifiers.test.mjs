import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRules, parseDenylist, scanFile } from "./check-private.mjs";

const term = ["work", "Items"].join("");
const policy = compileRules({ privateIdentifierExceptions: [{
  termParts: ["work", "Items"], path: "^src/worker\\.ts$", function: "run",
}] });
const deny = parseDenylist(term);
const scan = (text, path = "src/worker.ts", rules = deny) => scanFile(path, text, policy, rules);

test("only the declared local binding and its resolved references are exempt", () => {
  const source = `function run() { const ${term} = new Set(); ${term}.add(1); const clear = () => ${term}.clear(); }`;
  assert.deepEqual(scan(source), []);
  assert.ok(scan(source, "src/other.ts").length > 0);
  assert.ok(scan(source.replace("function run", "function other")).length > 0);
});

test("strings, paths, comments, properties and other bindings remain refused", () => {
  for (const extra of [
    `const text = "${term}";`, `const text = '${term}';`, `const text = \`/${term}/private\`;`,
    `// ${term}`, `const object = { ${term}: 1 };`, `object.${term};`,
    `function nested(${term}) { return ${term}; }`, `const object = { ${term} };`,
  ]) {
    assert.ok(scan(`function run() { const ${term} = new Set(); ${extra} }`).length > 0, extra);
  }
  assert.ok(scan(`export const ${term} = new Set();`).length > 0);
  assert.ok(scan(`function run() { let ${term} = new Set(); }`).length > 0);
  assert.ok(scan(`function run() { const ${term} = new Set(); }`, `src/${term}.ts`).length > 0);
  const regex = parseDenylist(`/${term}|AnonymousPrivateProject/i`);
  assert.deepEqual(scan(`function run() { const ${term} = new Set(); }`, "src/worker.ts", regex), []);
  assert.ok(scan(`function run() { const ${term} = "${term}"; }`, "src/worker.ts", regex).length > 0);
  assert.ok(scan("const name = 'AnonymousPrivateProject';", "src/worker.ts", regex).length > 0);
});

test("substring matches are not identifiers and malformed source fails closed", () => {
  assert.ok(scan(`function run() { const ${term}Project = 1; }`).length > 0);
  assert.ok(scan(`function run() { const ${term} = "${term}"; }`).length > 0);
  assert.ok(scan(`function run() { const ${term} = ; }`).length > 0);
});
