// Paseo runs this before compiling a newly acquired Git or npm candidate.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUNDLES = ["cli", "local-decisions", "migrate", "check-missing-cwd", "fleet-roles", "fleet-doctor", "fleet-coupon", "fleet-leader"];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Plugin preparation failed: ${command} exited ${result.status ?? result.signal}`);
}

export function preparePlugin(root = ROOT, execute = run) {
  // The compiler checks type imports too. NODE_ENV=production must not omit
  // the client SDK, protocol types or Node types used by the source entries.
  execute("npm", [existsSync(join(root, "package-lock.json")) ? "ci" : "install", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], root);
  const builder = join(root, "scripts", "build-cli.mjs");
  if (existsSync(builder)) execute(process.execPath, [builder], root);
  // npm packages already contain prepacked commands and omit repository gates.
  // Never silently accept an incomplete package or a failed source build.
  for (const name of BUNDLES) {
    if (!existsSync(join(root, "bin", `${name}.bundle.mjs`))) throw new Error(`Missing prepared command: ${name}.bundle.mjs`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { preparePlugin(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
