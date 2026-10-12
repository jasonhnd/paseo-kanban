#!/usr/bin/env node
// Legacy command alias. Resolve symlinks before locating the Node dispatcher.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
const child = spawn(process.execPath, [join(dirname(realpathSync(process.argv[1])), "afc.mjs"), "roles", ...process.argv.slice(2)], { stdio: "inherit" });
child.on("error", error => { console.error(error.message); process.exitCode = 127; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
