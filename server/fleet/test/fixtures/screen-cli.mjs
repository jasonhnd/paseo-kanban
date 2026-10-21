// Offline terminal fixture: every node stays alive and ignores terminal loss and TERM.
// No provider executable, credentials or network are used.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const root = process.argv[2] === undefined;
const depth = Number(process.argv[2] ?? process.env.DEMO_DEPTH);
const record = (file, value) => appendFileSync(file, `${value}\n`);
// The test runner can terminate a worker without running its hooks. Every node
// watches that worker so even a detached, TERM-resistant tree cannot outlive it.
const owner = Number(process.env.DEMO_OWNER_PID);
if (Number.isSafeInteger(owner) && owner > 1) setInterval(() => {
  try { process.kill(owner, 0); }
  catch (error) { if (error.code === "ESRCH") process.kill(process.pid, "SIGKILL"); }
}, 100);
process.on("SIGHUP", () => {});
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {
  record(process.env.DEMO_TERM_FILE, process.pid);
  if (root && process.env.DEMO_FORK_ON_TERM === "1") {
    const child = spawn(process.execPath, [import.meta.filename, "0"], { stdio: "ignore" });
    // Record at fork time: group KILL may arrive before the new Node runtime starts.
    if (child.pid) record(process.env.DEMO_PID_FILE, child.pid);
  }
});
record(process.env.DEMO_PID_FILE, process.pid);
if (root && process.env.DEMO_START_DELAY_MS) await delay(Number(process.env.DEMO_START_DELAY_MS));
if (depth > 0) spawn(process.execPath, [import.meta.filename, String(depth - 1)], { stdio: "ignore" });

if (root) {
  const ready = setInterval(() => {
    const count = readFileSync(process.env.DEMO_PID_FILE, "utf8").trim().split("\n").length;
    if (count < depth + 1) return;
    clearInterval(ready);
    if (process.env.DEMO_MODE === "login") console.log("Sign in");
    else if (process.env.DEMO_MODE !== "timeout") console.log("Awaiting your input\nPlan, search, build anything");
  }, 20);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += String(chunk);
    if (/\r|\n/.test(input) && process.env.DEMO_MODE === "success") {
      console.log("\x1b[2J\x1b[HWeekly limit\n42% used\nAuto 42% used");
      input = "";
    }
  });
}
setInterval(() => {}, 1_000);
