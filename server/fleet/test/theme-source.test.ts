import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

import { colorLiterals } from "../../../test/helpers/color-source";
const sourceExempt = (name: string) => name === "shared/theme-fallback.ts";

test("source exemptions contain only the single missing-host fallback", () => {
  assert.equal(sourceExempt("shared/theme-fallback.ts"), true);
  for (const name of ["client/__fixtures__/colors.ts", "shared/__fixtures__/colors.ts", "client/theme-fallback.ts", "shared/nested/theme-fallback.ts"]) {
    assert.equal(sourceExempt(name), false, name);
  }
});

test("client and shared have no color literals outside the missing-host fallback", async () => {
  const root = resolve(import.meta.dirname, "../../..");
  const failures: string[] = [];
  for (const dir of ["client", "shared"]) {
    for (const entry of await readdir(resolve(root, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|json|css)$/.test(entry.name)) continue;
      const path = resolve(entry.parentPath, entry.name);
      const name = relative(root, path).replaceAll("\\", "/");
      if (sourceExempt(name)) continue;
      const source = await readFile(path, "utf8");
      const colors = entry.name.endsWith(".css")
        ? [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?:color|background|fill|stroke|shadow|outline)\s*:\s*([^;}]+)/gi)]
          .flatMap(match => colorLiterals(`const color = ${JSON.stringify(match[1].trim())};`))
        : colorLiterals(source);
      if (colors.length) failures.push(`${name}: ${colors.join(", ")}`);
    }
  }
  assert.deepEqual(failures, [], "All paint must come from PluginTheme.colors");
});

test("color gate catches numeric, named, conditional and aliased paint without rejecting semantic tones", () => {
  for (const source of [
    'const p = { borderColor: "#123" };',
    'const p = { color: "rgb(1, 2, 3)" };',
    'const p = { backgroundColor: "hsl(20, 30%, 40%)" };',
    'const p = { color: on ? "tomato" : theme.colors.foreground };',
    'const arbitrary = "rebeccapurple"; const p = { color: arbitrary };',
    '<TextInput placeholderTextColor="gray" />',
    'const p = { backgroundColor: "transparent" };',
    'const arbitrary = "tomato";',
    'const p = { background: "linear-gradient(#123, #456)" };',
    'const p = { background: `linear-gradient(#123, ${theme.colors.surface0})` };',
  ]) assert.ok(colorLiterals(source).length, source);
  assert.deepEqual(colorLiterals('type Tone = "red" | "green"; const tone = "red"; if (tone === "green") {}'), []);
  assert.deepEqual(colorLiterals('const p = { color: theme.colors.foreground }; // formerly #123456'), []);
  assert.deepEqual(colorLiterals('const color = tone === "red" ? theme.colors.statusDanger : toneColor(s, "green");'), []);
  assert.deepEqual(colorLiterals('function format(r) { return `rgba(${r}, ${r}, ${r}, 1)`; }'), []);
});
