/// <reference types="node" />
// No module may translate while it loads: the server chooses its language after every module is
// imported, so a message looked up at import time would be stuck in the default language. A fresh
// process imports every server and shared module and checks that t() was never called.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function modules(): string[] {
  const list = (dir: string) =>
    readdirSync(join(root, dir))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
      .map((name) => join(root, dir, name));
  return [...list("shared"), ...list("server"), join(root, "index.server.ts")];
}

describe("module loading", () => {
  it("looks up no message while server and shared modules load", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "i18n-load-"));
    try {
      const urls = modules().map((file) => pathToFileURL(file).href);
      const script = `
        const i18n = await import(${JSON.stringify(pathToFileURL(join(root, "shared", "i18n.ts")).href)});
        const before = i18n.lookupCount();
        for (const url of ${JSON.stringify(urls)}) await import(url);
        process.stdout.write(JSON.stringify({ before, after: i18n.lookupCount(), language: i18n.getLanguage() }));
        process.exit(0);
      `;
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, KANBAN_DATA_DIR: dataDir },
        timeout: 120_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const outcome = JSON.parse(result.stdout) as { before: number; after: number; language: string };
      assert.equal(outcome.before, 0);
      assert.equal(outcome.after, 0, "a module called t() at import time");
      assert.equal(outcome.language, "en", "loading modules must not choose a language");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
