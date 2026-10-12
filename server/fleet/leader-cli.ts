import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { LeaderRpcClient } from "./leader-rpc-client";
import { initLanguage } from "./language";
import { CONFIG, readJson, sleep } from "./util";
import { t } from "../../shared/fleet/i18n";
import { formatContextTokens } from "../../shared/fleet/supervisor-shift-format";
import { leaderSwapRpc, leaderUsageRpc, type LeaderSwapResult } from "../../shared/fleet/leader-command";

export interface LeaderCliPorts {
  call(method: string, input: unknown): Promise<unknown>;
  write(text: string): void;
  progress(text: string): void;
  sleep(ms: number): Promise<void>;
}

/** Keep JSON stdout machine readable; progress goes to stderr when --json is requested. */
export async function runLeaderCli(args: string[], ports: LeaderCliPorts): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    json: { type: "boolean" }, "dry-run": { type: "boolean" }, again: { type: "boolean" }, help: { type: "boolean", short: "h" }, host: { type: "string" },
  } });
  if (values.help) { ports.write(t("leader.cli.usage")); return 0; }
  const [command, project] = positionals;
  if (command === "usage" && positionals.length === 1 && !values["dry-run"] && !values.again) {
    const report = leaderUsageRpc.output.parse(await ports.call(leaderUsageRpc.name, {}));
    if (values.json) ports.write(JSON.stringify(report, null, 2));
    else {
      ports.write(t("leader.usage.thresholds", { reminder: formatContextTokens(report.thresholds.reminderTokens), warning: formatContextTokens(report.thresholds.warningTokens) }));
      for (const row of report.rows) ports.write(t("leader.cli.usageRow", { project: row.project, tokens: row.contextTokens ?? "?", level: t(`leader.cli.level.${row.level}`), agent: row.agentId }));
    }
    return 0;
  }
  if (!["swap", "status", "cancel"].includes(command) || !project || positionals.length !== 2 || (command !== "swap" && values.again) || (command === "status" && values["dry-run"])) {
    ports.write(`${t("leader.cli.invalid")}\n${t("leader.cli.usage")}`); return 2;
  }
  let result = leaderSwapRpc.output.parse(await ports.call(leaderSwapRpc.name, { project, action: command === "swap" ? "run" : command, dryRun: values["dry-run"] === true, again: values.again === true }));
  let last = "";
  let seen = 0;
  for (;;) {
    for (const event of result.events.slice(Math.max(0, seen - result.eventsOffset))) ports.progress(t("leader.cli.progress", { step: event.step ?? event.phase, detail: event.detail, old: event.oldId, new: event.newId ?? "?" }));
    seen = result.eventsOffset + result.events.length;
    const job = result.job;
    const detail = job ? t("leader.cli.progress", { step: job.step ?? job.phase, detail: job.detail, old: job.oldId, new: job.newId ?? "?" }) : result.message;
    if (detail !== last && result.events.length === 0) { ports.progress(detail); last = detail; }
    if (command !== "swap" || values["dry-run"] || !result.running) break;
    await ports.sleep(500);
    result = leaderSwapRpc.output.parse(await ports.call(leaderSwapRpc.name, { project, action: "status" }));
  }
  if (values.json) ports.write(JSON.stringify(result, null, 2));
  else if (values["dry-run"]) ports.write(JSON.stringify(result.plan, null, 2));
  if (!result.ok || (!values["dry-run"] && result.job?.phase === "failed")) {
    ports.progress(t(result.job && !result.job.canContinue ? "leader.cli.manual" : "leader.cli.failed", { step: result.job?.step ?? result.job?.phase ?? command, reason: result.message, old: result.job?.oldId ?? "?", new: result.job?.newId ?? "?", project }));
    return 1;
  }
  return 0;
}

async function main() {
  initLanguage();
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) { console.log(t("leader.cli.usage")); return args.length ? 0 : 2; }
  const { values } = parseArgs({ args, allowPositionals: true, options: { host: { type: "string" }, json: { type: "boolean" }, "dry-run": { type: "boolean" }, again: { type: "boolean" } } });
  const config = await readJson<{ daemon?: { listen?: string } }>(CONFIG, {});
  const endpoint = values.host ?? config.daemon?.listen ?? "127.0.0.1:6767";
  if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(endpoint)) throw new Error(t("leader.cli.localOnly"));
  const client = new LeaderRpcClient(`ws://${endpoint}/ws`);
  try {
    await client.connect();
    return await runLeaderCli(args, {
      call: (method, input) => client.call(method, input),
      write: console.log, progress: values.json ? console.error : console.log, sleep,
    });
  } finally { await client.close(); }
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(t("leader.cli.disconnected", { error: String(error).slice(0, 300), project: process.argv[3] ?? "<project>" })); process.exitCode = 1;
  });
}
