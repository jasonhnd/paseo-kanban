/// <reference types="node" />
// A plugin reinstall changes the install directory name. Long-lived commands must keep using
// the data directory's stable bin, which startup rewrites to the current install.
import { BOARD_AGENT_ENV } from "../server/agent-env";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { displayCliPath } from "../server/fallback";
import { guardCreateHook, primeCliEnv, resetCliEnv } from "../server/inject";
import { checkoutRoot, dataDir, pluginRoot } from "../server/paths";
import { protocolFor } from "../server/protocol";
import { refreshStableBin, stableLauncherPath } from "../server/stable-bin";
import { runDoctor } from "../server/doctor";
import { translate } from "../shared/i18n";

const BRIDGE_PARTS = ["integrations", "hermes", "memory_bridge.py"] as const;
const LAUNCHER_NAME = "paseo-kanban";
const ERROR_NAME = "stable-bin-error";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function writeInstall(root: string, marker: string): void {
  const cli = join(root, "bin", "paseo-kanban.mjs");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(cli, `process.stdout.write(${JSON.stringify(marker)} + "\\n" + JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  chmodSync(cli, 0o755);
  mkdirSync(join(root, BRIDGE_PARTS[0], BRIDGE_PARTS[1]), { recursive: true });
  writeFileSync(join(root, ...BRIDGE_PARTS), `bridge ${marker}\n`);
}

function runLauncher(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(stableLauncherPath(), args, { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

describe("stable bin", { concurrency: 1 }, () => {
  const checkout = checkoutRoot();
  if (!checkout) throw new Error("checkout root is required");
  process.env.KANBAN_HOME = checkout;
  const scratch = mkdtempSync(join(tmpdir(), "stable-bin-"));
  const installA = join(scratch, "install-a");
  const installB = join(scratch, "install b'c");

  it("refreshes the launcher and the bridge copy for the current install", () => {
    writeInstall(installA, "marker-a");
    writeInstall(installB, "marker-b");
    const first = refreshStableBin(installA);
    assert.equal(first.ok, true, first.error);
    const bin = join(dataDir(), "bin");
    const launcher = stableLauncherPath();
    const bridge = join(bin, "memory_bridge.py");
    assert.equal(launcher, join(bin, LAUNCHER_NAME));
    assert.equal(first.launcher, launcher);
    assert.equal(mode(bin), 0o700);
    assert.equal(mode(launcher), 0o755);
    assert.equal(mode(bridge), 0o755);
    const script = readFileSync(launcher, "utf8");
    assert.match(script, /^#!\/bin\/sh\nexec /);
    assert.match(script, /"\$@"\n$/);
    assert.equal(readFileSync(bridge, "utf8"), "bridge marker-a\n");
    const ran = runLauncher(["supervise", "--project", "demo"]);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, `marker-a\n${JSON.stringify(["supervise", "--project", "demo"])}\n`);
    const bridgeTime = statSync(bridge).mtimeMs;
    const again = refreshStableBin(installA);
    assert.equal(again.ok, true, again.error);
    assert.equal(statSync(bridge).mtimeMs, bridgeTime);
    assert.equal(readFileSync(bridge, "utf8"), "bridge marker-a\n");
    const moved = refreshStableBin(installB);
    assert.equal(moved.ok, true, moved.error);
    assert.equal(readFileSync(bridge, "utf8"), "bridge marker-b\n");
    assert.doesNotMatch(readFileSync(launcher, "utf8"), /install-a/);
    const next = runLauncher(["handover"]);
    assert.equal(next.status, 0, next.stderr);
    assert.equal(next.stdout, `marker-b\n${JSON.stringify(["handover"])}\n`);
    refreshStableBin(pluginRoot());
  });

  it("puts only the stable command in the protocol and a new leader prompt", () => {
    const shown = displayCliPath();
    assert.equal(shown, displayCliPath(stableLauncherPath()));
    assert.doesNotMatch(shown, /paseo-kanban\.mjs/);
    for (const role of ["executor", "supervisor", "reviewer", "batch"]) {
      const text = protocolFor(role);
      assert.ok(text.includes(shown), role);
      assert.doesNotMatch(text, /paseo-kanban\.mjs/);
    }
    const created = guardCreateHook({
      config: { provider: "codex", cwd: "/work" },
      env: { [BOARD_AGENT_ENV]: "1", KANBAN_ROLE: "supervisor" },
    }, "http://127.0.0.1:9");
    const prompt = created?.config.systemPrompt ?? "";
    assert.ok(prompt.includes(shown));
    assert.doesNotMatch(prompt, /paseo-kanban\.mjs/);
    const vars = { project: JSON.stringify("demo"), version: "kanban/v1", cli: JSON.stringify(stableLauncherPath()) };
    for (const language of ["en", "zh-CN"] as const) {
      const intro = translate(language, "leaderStart.intro", vars);
      assert.ok(intro.includes(stableLauncherPath()), language);
      assert.doesNotMatch(intro, /paseo-kanban\.mjs/);
      assert.doesNotMatch(intro, /invoke Node|\u7528 Node \u6267\u884c/);
    }
    const source = readFileSync(join(import.meta.dirname, "..", "index.server.ts"), "utf8");
    const refreshAt = source.indexOf("refreshStableBin()");
    const primeAt = source.indexOf("primeCliEnv()");
    assert.ok(refreshAt !== -1 && primeAt !== -1 && refreshAt < primeAt);
  });

  it("reports a failed refresh as doctor yellow and still lets startup continue", async () => {
    const logs: string[] = [];
    const healthy = refreshStableBin(pluginRoot(), (message) => logs.push(message));
    assert.equal(healthy.ok, true, healthy.error);
    assert.equal(logs.length, 0);
    const missing = join(scratch, "missing-install");
    const failed = refreshStableBin(missing, (message) => logs.push(message));
    assert.equal(failed.ok, false);
    assert.match(logs.join("\n"), /\[paseo-kanban\] stable bin:/);
    const errorFile = join(dataDir(), ERROR_NAME);
    assert.match(readFileSync(errorFile, "utf8"), /\S/);
    assert.equal(mode(errorFile), 0o600);
    try {
      const primed = primeCliEnv();
      assert.equal(primed.KANBAN_CLI, stableLauncherPath());
      assert.doesNotMatch(primed.KANBAN_CLI, /paseo-kanban\.mjs/);
      const report = await runDoctor({ sources: {}, wake: false, persist: false });
      const finding = report.findings.find((item) => item.id === "stable-bin");
      assert.equal(finding?.severity, "yellow");
      assert.ok(finding?.suggestion.includes(stableLauncherPath()));
      assert.match(finding?.suggestion ?? "", /memory_bridge\.py/);
      const repaired = refreshStableBin(pluginRoot());
      assert.equal(repaired.ok, true, repaired.error);
      assert.equal(existsSync(errorFile), false);
      const cleared = await runDoctor({ sources: {}, wake: false, persist: false });
      assert.equal(cleared.findings.find((item) => item.id === "stable-bin"), undefined);
    } finally {
      resetCliEnv();
      refreshStableBin(pluginRoot());
    }
  });
});
