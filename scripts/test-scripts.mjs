#!/usr/bin/env node
// Script and native suites use the same private runtime environment as plugin tests.
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPhasesInPrivateTmp } from "../test/helpers/test-tmp.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = process.argv.slice(2);
if (!files.length) files.push(...readdirSync(join(root, "scripts")).filter(name => name.endsWith(".test.mjs")).sort().map(name => `scripts/${name}`));
delete process.env.NODE_TEST_CONTEXT;
process.exitCode = await runPhasesInPrivateTmp([["tests", ...files]], { cwd: root, logPrefix: "test-scripts" });
