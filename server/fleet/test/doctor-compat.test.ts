import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCompat } from "../../../shared/fleet/doctor-checks";
import { setLanguage } from "../../../shared/fleet/i18n";
import { runDoctor, type DoctorDeps } from "../doctor";
import type { CompatContext } from "../upgrade-check";

setLanguage("en");
const now = Date.parse("2026-01-02T01:00:00Z");
function check(status: string, stale = false) {
  return checkCompat({ version: "0.12.0", recordedAt: new Date(now).toISOString(), results: [
    { id: "demo", label: "Demo", status, conclusion: "Demo result", stale },
  ] }, now, "demo/compat-state.json");
}

for (const [status, color] of [["pass", "green"], ["fail", "red"], ["timeout", "red"], ["missing", "yellow"], ["unknown", "yellow"], ["pending", "yellow"], ["future-status", "yellow"]]) {
  test(`doctor maps ${status} to ${color}`, () => {
    const item = check(status);
    assert.equal(item.status, color);
    if (color === "yellow") {
      assert.match(item.findings[0]!.text, /unverified/i);
      assert.doesNotMatch(item.summary, /all .* passed/i);
    }
  });
}

test("doctor marks a stale pass unverified but retains a stale executed failure as red", () => {
  assert.equal(check("pass", true).status, "yellow");
  assert.equal(check("fail", true).status, "red");
  assert.match(check("fail", true).findings[0]!.text, /stale/i);
});

test("doctor reads current host/plugin identities without running compat or writing state", async () => {
  for (const status of ["pass", "fail", "timeout", "missing"] as const) {
    for (const change of ["unchanged", "host", "installation", "rename"] as const) {
      const context: CompatContext = { version: change === "host" ? "0.13.0" : "0.12.0", plugins: [{
        id: change === "rename" ? "renamed" : "demo", label: change === "rename" ? "Renamed" : "Demo", dir: "/demo/plugin", cwdMatch: "demo", project: "demo",
        identity: change === "installation" ? "install-2" : "install-1", hasCompatScript: true,
      }] };
      const deps: DoctorDeps = {
        now: () => now, stateDir: "/demo/state", paseoDir: "/demo/host", configPath: "/demo/host/config.json",
        kanbanRoot: "/demo/plugin", paseoBin: "demo-paseo",
        run: async (_cmd, args) => {
          assert.ok(!args.includes("compat"));
          return { ok: true, stdout: "[]", stderr: "", error: null, timedOut: false, exitCode: 0 };
        },
        readJson: async path => path.endsWith("compat-state.json") ? {
          version: "0.12.0", recordedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(),
          results: [{ id: "demo", label: "Demo", status, conclusion: "Demo result", identity: "install-1" }],
        } : {},
        readTail: async () => null, listLogs: async () => [], pathDirs: async () => [],
        isFile: () => false, realpath: path => path, compatContext: async () => context,
      };
      const item = (await runDoctor(deps)).items.find(row => row.id === "compat")!;
      const expected = status === "fail" || status === "timeout" ? "red" : status === "pass" && change === "unchanged" ? "green" : "yellow";
      assert.equal(item.status, expected, `${status}/${change}`);
      if (expected === "yellow") assert.match(item.findings[0]!.text, /unverified/i);
      if (change === "rename" && expected === "red") {
        assert.match(item.findings[0]!.text, /Renamed.*Demo result.*stale/i);
      }
      assert.equal(item.findings[0]?.key, `compat:${change === "rename" ? "renamed" : "demo"}`);
    }
  }
});
