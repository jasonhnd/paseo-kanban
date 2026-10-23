#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const own = new Map([["decide", "local-decisions"], ["migrate", "migrate"]]).get(args[0]);
const entry = join(dirname(fileURLToPath(import.meta.url)), `${own ?? "cli"}.bundle.mjs`);
if (!existsSync(entry)) {
  console.error("CLI bundles are missing; run npm run build in the checkout before using this command.");
  process.exitCode = 1;
} else if (args.filter(arg => arg !== "--json")[0] === "wait-bg") {
  // Preserve the invoking shell as our parent for background-process authorization.
  process.argv[1] = entry;
  await import(pathToFileURL(entry).href);
} else {
  const child = spawn(process.execPath, [entry, ...(own ? args.slice(1) : args)], { stdio: "inherit" });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
