import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { createPaseoClient } from "../paseo-client.bundle.mjs";

// Exercise the shipped module outside the checkout, with only its production dependencies.
test("the background client can initialize with its declared production SDK packages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "afc-client-"));
  try {
    const file = join(dir, "client.mjs");
    const unrelatedCwd = join(dir, "unrelated", "working-directory");
    await mkdir(unrelatedCwd, { recursive: true });
    await mkdir(join(dir, "node_modules"));
    await mkdir(join(dir, "node_modules/@getpaseo"));
    for (const name of ["zod", "@getpaseo/client", "@getpaseo/protocol", "@getpaseo/relay"]) {
      await symlink(new URL(`../../../node_modules/${name}`, import.meta.url).pathname, join(dir, "node_modules", name));
    }
    await copyFile(new URL("../paseo-client.bundle.mjs", import.meta.url), file);
    // Expose the generated require shim to prove its base is the module, not cwd.
    await appendFile(file, '\nexport const resolveDependency = async () => (await import("node:module")).createRequire(import.meta.url).resolve("zod");\n');
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { pathToFileURL } from "node:url";
      const { createPaseoClient, resolveDependency } = await import(pathToFileURL(process.argv[1]).href);
      if (!(await resolveDependency()).includes("zod")) throw new Error("Module dependency resolution failed");
      const client = createPaseoClient({ url: "ws://127.0.0.1:0/ws", clientId: "offline-test",
        connectTimeoutMs: 100, reconnect: { enabled: false } });
      if (typeof client.providers.listUsage !== "function" || typeof client.agents.list !== "function")
        throw new Error("The background API is incomplete");
      await client.close();
      console.log("ready");
    `, file], { cwd: unrelatedCwd, encoding: "utf8", timeout: 10_000 });
    assert.match(output, /ready/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the generated client loads after a host compiler clears import.meta.url", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../paseo-client.bundle.mjs", import.meta.url))],
    bundle: true, format: "cjs", platform: "node", target: "node20", write: false,
    external: ["zod", "@getpaseo/protocol", "@getpaseo/relay"], logLevel: "silent",
  });
  const module = { exports: {} as { createPaseoClient: typeof createPaseoClient } };
  const evaluate = new Function("require", "module", "exports", result.outputFiles[0].text);
  evaluate(createRequire(import.meta.url), module, module.exports);
  const client = module.exports.createPaseoClient({ url: "ws://127.0.0.1:0/ws", clientId: "wrapper-test",
    connectTimeoutMs: 100, reconnect: { enabled: false } });
  assert.equal(typeof client.providers.listUsage, "function");
  await client.close();
});
