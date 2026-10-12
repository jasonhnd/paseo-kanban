#!/usr/bin/env node
// Runs the same two phases as bin/test.mjs, but with a lower test concurrency:
// V8 coverage slows every spawned CLI child, and at full parallelism the
// subprocess-heavy tests time out. Launched through c8 by `npm run coverage`.
import { root, testPhases } from "./test-phases.mjs";
import { runPhasesInPrivateTmp } from "./test-tmp.mjs";

const COVERAGE_TEST_CONCURRENCY = process.env.KANBAN_COVERAGE_CONCURRENCY ?? "4";
process.exit(await runPhasesInPrivateTmp(testPhases(), { cwd: root, logPrefix: "coverage", extraTestArgs: [`--test-concurrency=${COVERAGE_TEST_CONCURRENCY}`] }));
