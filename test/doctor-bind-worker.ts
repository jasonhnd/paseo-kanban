/// <reference types="node" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, mock } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import type { DoctorSources } from "../server/doctor";

// Keep contribute/bind and the wake/doctor code real. Disable only background
// services and external connections, so registration cannot touch live Paseo.
mock.module(new URL("../server/mcp.ts", import.meta.url).href, {
  namedExports: { startMcpServer: async () => ({ url: "http://fixture", port: 0, replaced: false, close: async () => {} }) },
});
mock.module(new URL("../server/loop.ts", import.meta.url).href, {
  namedExports: { bindScheduler: () => ({ reused: false, kick: async () => {}, release() {} }) },
});
mock.module(new URL("../server/early-bind.ts", import.meta.url).href, {
  namedExports: { startEarlyBind: () => ({ stop() {} }) },
});
const missing = await import("../server/missing-cwd");
mock.module(new URL("../server/missing-cwd.ts", import.meta.url).href, {
  namedExports: { ...missing, startMissingCwdPatrol: () => () => {} },
});
const { default: contribute } = await import("../index.server");
const { doctorSettings, loadConfig, saveConfig } = await import("../server/config");
const { closeDb } = await import("../server/db");
const { runDoctor, readLastDoctorReport } = await import("../server/doctor");
const { setAgentAliveCheck, resetAgentAliveCheck } = await import("../server/alive");
const { hookObjects } = await import("../server/hook-objects");

it("production bind propagates an asynchronous Paseo send rejection to doctor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-bind-"));
  process.env.KANBAN_DATA_DIR = dir;
  process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
  mkdirSync(process.env.KANBAN_AGENTS_DIR);
  saveConfig({ ...loadConfig(), supervisorAgentId: "fixture-boss" });
  setAgentAliveCheck(() => true);
  const handlers = new Map<string, (event: unknown, context: { paseo: PaseoApi }) => unknown>();
  const server = {
    before: () => () => {},
    on: (name: string, fn: (event: unknown, context: { paseo: PaseoApi }) => unknown) => { handlers.set(name, fn); return () => handlers.delete(name); },
    handle: () => {},
  } as unknown as PluginServerContext;
  let sends = 0;
  let fail = true;
  const paseo = {
    agents: { ref: (id: string) => ({
      send: async () => {
        assert.equal(id, "fixture-boss");
        sends++;
        await new Promise((resolve) => setImmediate(resolve));
        if (fail) throw new Error("fixture async send rejected");
      },
    }) },
  } as unknown as PaseoApi;
  const errors: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  const log = mock.method(console, "error", (...args: unknown[]) => errors.push(args.map(String).join(" ")));
  let unload: (() => Promise<void>) | undefined;
  try {
    unload = contribute(server);
    assert.ok(handlers.has("agent.created"));
    hookObjects.rememberAgent("fixture-worker");
    await handlers.get("agent.created")!({ agent: { id: "fixture-worker" } }, { paseo }); // Calls the real private bind for a known Kanban agent.
    const sources: DoctorSources = { workspaces: [{ id: "stale-fixture", name: "fixture", directory: join(dir, "stale"), kind: "worktree", projectRoot: dir, archived: false }] };
    const input = { sources, settings: { ...doctorSettings(null), totalTimeoutMs: 2_000 }, wake: true, persist: true };
    const rejected = await runDoctor(input);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sends, 1, "the doctor alert must reach the sender installed by production bind");
    assert.ok(rejected.findings.length > 0);
    assert.deepEqual(rejected.alertedIds, [], "rejected sends are not delivered alerts");
    assert.deepEqual(readLastDoctorReport()?.alertedIds, []);
    assert.ok(errors.some((line) => line.includes("[paseo-kanban] wake") && line.includes("fixture async send rejected")));
    assert.deepEqual(unhandled, [], "async rejection must be consumed");
    fail = false;
    const accepted = await runDoctor(input);
    assert.equal(sends, 2, "the failed alert must be retryable");
    assert.equal(accepted.alertedIds.length, 1);
  } finally {
    await unload?.();
    log.mock.restore();
    process.off("unhandledRejection", onUnhandled);
    resetAgentAliveCheck();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
