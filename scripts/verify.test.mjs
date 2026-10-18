// Tests for verify.mjs. The real gate set is not run here (verify runs these tests itself).
import assert from "node:assert/strict";
import { test } from "node:test";
import { runSteps, steps } from "./verify.mjs";

test("the gate set covers required local publication checks", () => {
  const names = steps().map((step) => step.name);
  for (const gate of ["typecheck", "test (scripts)", "test (plugin)", "build (CLI)", "build (Paseo)", "scan (check-private --all)", "scan (public occurrence freshness)", "identity (next commit)", "identity (history)", "gitleaks (history)", "contract (single source + compatibility)", "shared gates (single source)", "pack:check"]) {
    assert.ok(names.includes(gate), gate);
  }
  const testStep = steps().find((step) => step.name === "test (scripts)");
  assert.ok(testStep.command.includes("scripts/verify.test.mjs"));
});

test("every step runs after a failure, and a missing tool is a failure", () => {
  const node = process.execPath;
  const results = runSteps([
    { name: "fails", command: [node, "-e", "process.exit(3)"] },
    { name: "passes", command: [node, "-e", ""] },
    { name: "missing", command: ["paseo-fleet-no-such-tool"], missing: "install it" },
  ], process.cwd(), () => {});
  assert.deepEqual(results, [
    { name: "fails", ok: false, why: "exit 3" },
    { name: "passes", ok: true, why: "" },
    { name: "missing", ok: false, why: "install it" },
  ]);
});
