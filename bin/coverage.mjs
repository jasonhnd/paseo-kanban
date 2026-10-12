#!/usr/bin/env node
// `npm run coverage`: runs c8 around the same two test phases as `npm test`.
// The V8 coverage data and every test temp dir live under one private root
// that is removed once the report is printed (also on failure and signals).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTmp, removeTestTmp } from "../test/helpers/test-tmp.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIGNAL_EXIT_BASE = 128;
const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
const coverageRoot = createTestTmp();
const c8Args = [
  "--all", "--src", "server", "--src", "shared", "--include", "server/**", "--include", "shared/**",
  "--exclude", "test/**", "--exclude", "**/*.d.ts", "--temp-directory", join(coverageRoot, "c8"), "-r", "text",
  process.execPath, "test/helpers/coverage-phases.mjs",
];
let interruptedBy = null;
const child = spawn(join(root, "node_modules/.bin/c8"), c8Args, { stdio: "inherit", cwd: root, env: { ...process.env, TMPDIR: coverageRoot } });
const onSignal = signal => { interruptedBy = signal; child.kill(signal); };
for (const signal of Object.keys(SIGNAL_NUMBERS)) process.on(signal, onSignal);
child.on("error", error => { console.error(error.message); removeTestTmp(coverageRoot); process.exit(1); });
child.on("close", (status, signal) => {
  removeTestTmp(coverageRoot);
  if (interruptedBy) process.exit(SIGNAL_EXIT_BASE + SIGNAL_NUMBERS[interruptedBy]);
  process.exit(status ?? (signal ? SIGNAL_EXIT_BASE + (SIGNAL_NUMBERS[signal] ?? 1) : 1));
});
