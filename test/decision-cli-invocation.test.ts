/// <reference types="node" />
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { commandInvocation } from "../server/command-invocation";
import { envelopeFor } from "../server/contract";
import { decisionBackend, listDecisions, setDecideExec } from "../server/decisions";
import { primeCliEnv, resetCliEnv } from "../server/inject";

const KEYS = ["PASEO_HOME", "KANBAN_PASEO_CONFIG", "KANBAN_DATA_DIR", "AFC_DATA_DIR", "AFC_LEGACY_DATA_DIR", "ROLES_STATE_DIR"] as const;
const originalHome = process.env.HOME;
let saved: NodeJS.ProcessEnv;
let root: string;
let dataDir: string;
let exportsDir: string;

beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "decision-cli-invocation-"));
  dataDir = join(root, "board", "fleet");
  exportsDir = join(root, "board", "exports", "fleet");
  mkdirSync(exportsDir, { recursive: true });
  process.env.PASEO_HOME = join(root, "paseo");
  process.env.KANBAN_PASEO_CONFIG = join(root, "config.json");
  process.env.KANBAN_DATA_DIR = join(root, "board");


  delete process.env.ROLES_STATE_DIR;
  setDecideExec(null);
});

afterEach(() => {
  setDecideExec(null);
  resetCliEnv();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  assert.equal(process.env.HOME, originalHome);
  rmSync(root, { recursive: true, force: true });
});

describe("Fleet decision CLI invocation", () => {
  for (const extension of ["mjs", "js"]) {
    it(`runs an exported .${extension} CLI without executable bits through the current Node runtime`, async () => {
      const cli = join(root, `fleet command.${extension}`);
      writeFileSync(cli, 'process.stdout.write(JSON.stringify({ execPath: process.execPath, args: process.argv.slice(2) }));\n');
      chmodSync(cli, 0o600);
      assert.equal(statSync(cli).mode & 0o111, 0);
      writeFileSync(join(exportsDir, "cockpit.json"), JSON.stringify({ ...envelopeFor("cockpit", "0.0.0"), dataDir, cli, features: [] }));
      assert.deepEqual(commandInvocation(cli, ["decide", "ls", "--all"]), {
        command: process.execPath, args: [cli, "decide", "ls", "--all"],
      });
      assert.deepEqual(decisionBackend(), { kind: "cockpit", cli });
      assert.equal(primeCliEnv().AFC_CLI, cli, "agent injection keeps the exported path unchanged");
      const result = await listDecisions({ all: true });
      assert.equal(result.backend, "cockpit");
      assert.deepEqual(JSON.parse(result.output), { execPath: process.execPath, args: ["decide", "ls", "--all"] });
    });
  }

  it("keeps native and PATH commands unchanged and copies their argument list", () => {
    const args = ["decide", "ls"];
    for (const cli of ["roles", "/opt/example/bin/afc"]) {
      const invocation = commandInvocation(cli, args);
      assert.deepEqual(invocation, { command: cli, args });
      assert.notEqual(invocation.args, args);
    }
  });
});
