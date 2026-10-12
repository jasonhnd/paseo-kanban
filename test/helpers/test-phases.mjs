// Single source for the two test phases shared by bin/test.mjs and
// test/helpers/coverage-phases.mjs. The wall-clock performance gates get their
// own process after every ordinary test worker has exited.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const testDir = join(root, "test");
// The vendored fleet-quota contract carries its own tests.
const contractTestDir = join(root, "server", "contract", "test");
const ISOLATED_NAMES = ["native-sessions.test.ts", "tick-scale.test.ts"];

export function testPhases() {
  const isolatedFiles = ISOLATED_NAMES.map(name => join(testDir, name));
  const files = [testDir, contractTestDir].filter(dir => existsSync(dir)).flatMap(dir => readdirSync(dir, { recursive: true })
    .filter(name => typeof name === "string" && name.endsWith(".test.ts"))
    .map(name => join(dir, name))).sort();
  for (const isolatedFile of isolatedFiles) {
    if (!files.includes(isolatedFile)) throw new Error(`Required performance test file missing: ${isolatedFile}`);
  }
  return [
    ["parallel regression", ...files.filter(file => !isolatedFiles.includes(file))],
    ["isolated performance gates (native sessions, tick and board scale)", ...isolatedFiles],
  ];
}
