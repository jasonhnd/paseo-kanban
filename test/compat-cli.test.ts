/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("compat cli entry", () => {
  it("prints the failure and exits 1 when the offline test budget is invalid", () => {
    // Fails while building its dependencies, before any check, test or daemon call can start.
    const run = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(root, "server/compat-cli.ts")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, KANBAN_COMPAT_OFFLINE_TEST_TIMEOUT_MS: "not-a-number" },
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, new RegExp(zhCN("compat.failed", {"reason":zhCN("compat.env.offlineTimeout")})));
  });
});
