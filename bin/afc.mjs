#!/usr/bin/env node
// Dispatch standalone Node bundles; the development checkout and exported plugin share this launcher.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const routes = { leader: ["fleet-leader", []], roles: ["fleet-roles", []], decide: ["fleet-roles", ["decide"]], doctor: ["fleet-doctor", []], coupon: ["fleet-coupon", []] };
const usage = "usage: afc roles ls|check|set|history|pause|resume [args] | decide add|ls|done|comment|decided|overturn|stale|migrate [args] | doctor [--json] | coupon [--help] | leader usage|swap|status|cancel [args]";
const command = args[0];
if (!command || ["--help", "-h", "help"].includes(command)) {
  console.log(usage); process.exitCode = command ? 0 : 1;
} else if (!Object.hasOwn(routes, command)) {
  console.error(`afc: unknown command "${command}"\n\n${usage}`); process.exitCode = 1;
} else {
  const [name, prefix] = routes[command];
  const candidates = [join(bin, `${name}.bundle.mjs`)];
  const entry = candidates.find(existsSync);
  if (!entry) {
    console.error("CLI bundles are missing; run npm run build:cli in the plugin checkout before using this command."); process.exitCode = 1;
  } else {
    const env = { ...process.env };
    const child = spawn(process.execPath, [entry, ...prefix, ...args.slice(1)], { stdio: "inherit", env });
    child.on("error", error => { console.error(`afc: ${error.message}`); process.exitCode = 127; });
    child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  }
}
