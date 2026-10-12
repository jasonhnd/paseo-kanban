#!/usr/bin/env node
import { root, testPhases } from "../test/helpers/test-phases.mjs";
import { runPhasesInPrivateTmp } from "../test/helpers/test-tmp.mjs";

process.exit(await runPhasesInPrivateTmp(testPhases(), { cwd: root, logPrefix: "test" }));
