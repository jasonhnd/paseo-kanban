/// <reference types="node" />
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const starImport = "import \\* as [A-Za-z0-9_]+ from [\"']node:fs[\"']";
const starExport = "export \\* from [\"']node:fs[\"']";
const bareAccess = "fs\\.(F_OK|R_OK|W_OK|X_OK)\\b";

test("host-style server bundle does not emit DEP0176", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-dep-"));
  try {
    const entry = join(dir, "entry.ts");
    const target = join(root, "package.json");
    writeFileSync(entry, `
      import { canonicalPath } from ${JSON.stringify(join(root, "server/paths.ts"))};
      import { chmodSync, existsSync, realpathSync } from ${JSON.stringify(join(root, "server/perf-fs.ts"))};
      const target = ${JSON.stringify(target)};
      if (typeof existsSync !== "function" || existsSync(target) !== true) throw new Error("existsSync broken");
      if (typeof chmodSync !== "function" || typeof realpathSync !== "function") throw new Error("fs re-export broken");
      if (!canonicalPath(target).endsWith("package.json")) throw new Error("canonicalPath broken");
      console.log("loaded");
    `);
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node20",
      write: false,
      logLevel: "silent",
      absWorkingDir: root,
    });
    const code = result.outputFiles[0].text.replaceAll("get: () => from[key]", "value: from[key]");
    const outfile = join(dir, "bundle.cjs");
    writeFileSync(outfile, code);
    const child = spawnSync(process.execPath, ["--trace-deprecation", outfile], { encoding: "utf8" });
    assert.equal(child.status, 0, "bundled server entry failed to load");
    assert.equal(child.stdout.trim(), "loaded");
    assert.equal(/DEP0176|fs\.F_OK is deprecated/.test(child.stderr), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const scan = spawnSync("git", [
    "grep", "-n", "-E", `${starImport}|${starExport}|${bareAccess}`,
    "--", "server", "client", "shared", "scripts", "bin", "index.server.ts", "index.client.tsx",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(scan.status, 1, scan.stdout);
});
