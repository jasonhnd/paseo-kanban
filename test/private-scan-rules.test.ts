import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";

// The scanner is plain JavaScript shared with the cockpit; load it by URL so tsc does not need a declaration.
type Hit = { rule: string };
type Scanner = {
  loadRules(): unknown;
  scanFile(path: string, text: string, compiled: unknown, privateRules?: unknown[]): Hit[];
};

const scripts = join(import.meta.dirname, "..", "scripts");
const scanner: Scanner = await import(pathToFileURL(join(scripts, "check-private.mjs")).href);
const compiled = scanner.loadRules();
const j = (...parts: string[]) => parts.join("");
const rulesHit = (path: string, text: string) => scanner.scanFile(path, text, compiled).map(hit => hit.rule);

// The same table in paseo-fleet, EX and Kanban, whose rules files carry the same CJK rule.
const cjkAllowed = [
  "locales/zh-CN.json",
  "shared/locales/zh-CN.json",
  "packages/x/locales/zh-CN.json",
  "packages/x/shared/locales/zh-CN.json",
  "cockpit/shared/locales/zh-CN.json",
  "shared/locales/zh-CN/tools.json",
  "packages/x/locales/zh-CN/tools.json",
  "packages/x/shared/locales/zh-CN/tools.json",
  "server/protocol/zh-CN/lead.md",
  "packages/x/server/protocol/zh-CN/lead.md",
  "docs/zh-CN/guide.md",
];
const cjkRefused = [
  "shared/locales/en.json",
  "packages/x/locales/en.json",
  "packages/x/shared/locales/en.json",
  "cockpit/shared/locales/en.json",
  "packages/x/locales/en/tools.json",
  "packages/x/shared/locales/zh-CN.jsonc",
  "packages/x/shared/zh-CN.json",
  "packages/x/server/foo.ts",
  "packages/x/server/protocol/en/lead.md",
  "packages/x/shared/i18n.ts",
  "a/b/c/locales/zh-CN.json",
  "docs/guide.md",
  "README.md",
];
for (const path of cjkAllowed) {
  it(`CJK is allowed in ${path}`, () => {
    assert.deepEqual(rulesHit(path, j("\u770b", "\u677f")), []);
  });
}
for (const path of cjkRefused) {
  it(`CJK is refused in ${path}`, () => {
    assert.ok(rulesHit(path, j("\u770b", "\u677f")).includes("cjk-outside-locales"));
  });
}
