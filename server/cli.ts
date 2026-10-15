/// <reference types="node" />
import { leaderActionNote } from "./protocol";
import { protocolText } from "./protocol-text";
import { t } from "../shared/i18n";
import { applyServerLanguage } from "./language";
import { briefFileTemporaryRoots, readBriefFile } from "./brief-file";
import { pathToFileURL } from "node:url";
import { createPaseoClient } from "@getpaseo/client";
import { formatAudit, performAudit, type AuditView } from "./audit";
import { compactVerifyEvents, DEFAULT_RETENTION_DAYS } from "./compact-events";
import { vacuumKanbanDb } from "./vacuum";
import { connectAndCollect } from "./doctor-live";
import { formatDoctor, readLastDoctorReport, runDoctor, type DoctorSources } from "./doctor";
import { parentIdsFromFlags, parseKanbanArgs, wantsHelp, type ParsedArgs } from "./argv";
import { assertCodeNotShown, resolveTaskId } from "./card-ref";
import { retiredDefaultWorktree, assertConfigReadable, doctorSettings, findConfiguredProject, listProjectWorkspaces, loadConfig, loadConfigForReport, projectCode, projectWorkspace, setProjectCode, setProjectWorkspace } from "./config";
import { KanbanError } from "./errors";
import { handoverLeader } from "./handover";
import { assertSafeAgentId } from "./agent-id";
import { assertCliCommandAllowed, assertNotLeaderAgent, assertProjectScope, assertSupervisorScope, isKanbanLeader, resolveCliIdentity, resolveCompactIdentity } from "./identity";
import { superviseProject } from "./leader-registry";
import { auditView, launcherFrom } from "./paseo";
import type { AgentPresence } from "./presence";
import { livePresence } from "./live-presence";
import { nativeSessionsCommand } from "./native-sessions";
import { purgeCardAgents } from "./missing-cwd";
import { requestRebuiltCleanup } from "./cleanup";
import { resumeCleanup } from "./archive-book";
import { rebindTask } from "./rebind";
import { startTask, type AgentLauncher } from "./dispatch";
import { addTaskTags, getTask } from "./store";
import type { Identity } from "./tokens";
import { formatResult, handleTool } from "./tools";
import { openReadonlyDb } from "./db";
import { auditWrite, withWriteTransport } from "./write-source";

/** The command-line help: server/protocol/<language>/cli-help.md. */
export function kanbanHelp(): string {
  return protocolText("cli-help", { leaderActionNote: leaderActionNote() });
}

const COMMANDS: Record<string, { flags: readonly string[]; positionals: "none" | "one" | "rest" }> = {
  help: { flags: [], positionals: "none" },
  ping: { flags: [], positionals: "none" },
  audit: { flags: [], positionals: "none" },
  doctor: { flags: ["last"], positionals: "none" },
  list: { flags: ["project"], positionals: "none" },
  show: { flags: ["id"], positionals: "one" },
  comment: { flags: ["id", "text"], positionals: "rest" },
  complete: { flags: ["id", "summary", "handoff", "on-behalf"], positionals: "one" },
  block: { flags: ["id", "reason", "kind"], positionals: "one" },
  approve: { flags: ["id", "summary"], positionals: "one" },
  "request-changes": { flags: ["id", "reason", "findings"], positionals: "one" },
  create: { flags: ["project", "title", "role", "workspace", "profile", "brief", "brief-file", "parents", "parent", "contract", "max-retries", "tag", "effort", "tier", "reviews", "decision"], positionals: "none" },
  tag: { flags: ["id", "tag"], positionals: "one" },
  reject: { flags: ["id", "reason"], positionals: "one" },
  rework: { flags: ["id", "reason", "agent", "count-round"], positionals: "one" },
  pass: { flags: ["id", "note"], positionals: "one" },
  link: { flags: ["id", "parent"], positionals: "one" },
  unlink: { flags: ["id", "parent", "parents"], positionals: "one" },
  "grant-read": { flags: ["id", "scope"], positionals: "one" },
  "revoke-read": { flags: ["id"], positionals: "one" },
  unblock: { flags: ["id"], positionals: "one" },
  "wait-user": { flags: ["id", "decision"], positionals: "one" },
  unwait: { flags: ["id"], positionals: "one" },
  accept: { flags: ["id", "artifact", "reason"], positionals: "one" },
  start: { flags: ["id", "force"], positionals: "one" },
  archive: { flags: ["id"], positionals: "one" },
  register: { flags: ["project", "title", "brief", "role", "profile", "provider", "model", "thinking", "agent", "family", "workspace", "idempotency"], positionals: "none" },
  supervise: { flags: ["project"], positionals: "none" },
  handover: { flags: ["project", "to", "from", "dry-run", "kanban-leader"], positionals: "none" },
  project: { flags: ["project", "workspace", "base", "lanes", "allow-lanes", "parallel", "always-temp", "wait-parent-pr", "code"], positionals: "none" },
  rebind: { flags: ["id", "agent"], positionals: "one" },
  "purge-agents": { flags: ["id", "dry-run"], positionals: "one" },
  "resume-cleanup": { flags: ["id"], positionals: "one" },
  "native-sessions": { flags: ["sweep", "dry-run", "apply", "restore", "restore-manifest", "reset-failed", "reconcile-codex", "reconcile-claude", "include-tmp-sessions", "project", "limit", "offset"], positionals: "none" },
  "compact-events": { flags: ["dry-run", "apply", "days"], positionals: "none" },
  vacuum: { flags: ["dry-run", "apply"], positionals: "none" },
};

function assertKnownArgs(parsed: ParsedArgs): void {
  const spec = COMMANDS[parsed.cmd];
  if (!spec) throw new KanbanError("invalid", t("cli.unknownCommand", { command: parsed.cmd }));
  for (const name of parsed.flagNames()) {
    if (!spec.flags.includes(name)) throw new KanbanError("invalid", t("cli.unknownArgument", { argument: `--${name}` }));
  }
  if (spec.positionals === "none" && parsed.positionals.length > 0) {
    throw new KanbanError("invalid", t("cli.unknownArgument", { argument: parsed.positionals[0] }));
  }
  if (spec.positionals === "one" && parsed.positionals.length > 1) {
    throw new KanbanError("invalid", t("cli.unknownArgument", { argument: parsed.positionals[1] }));
  }
}

/** Changing a project's settings: its own <leader> or the Kanban <leader>; a project not configured yet only the Kanban <leader> or the terminal. */
function assertProjectSettingsScope(identity: Identity, project: string): void {
  if (!identity.agentId || isKanbanLeader(identity.agentId)) return;
  if (!findConfiguredProject(project)) {
    throw new KanbanError("forbidden", t("cli.newProjectOnlyKanbanLeader", { project }));
  }
  assertProjectScope(identity, project, t("cli.action.changeMode"));
}

function print(json: boolean, data: unknown): void {
  if (typeof data === "string") {
    console.log(data);
    return;
  }
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(formatResult(data));
}

interface KanbanHooks {
  startReaders?: Pick<NonNullable<Parameters<typeof startTask>[3]>, "readMatrix" | "readSnapshot">;
  auditView?: AuditView;
  doctorSources?: DoctorSources;
  agentPresence?: (agentId: string) => Promise<AgentPresence> | AgentPresence;
  launcher?: AgentLauncher;
}

function commandWrites(parsed: ParsedArgs): boolean {
  if (["list", "show"].includes(parsed.cmd) || parsed.flag("dry-run") === "true") return false;
  if (parsed.cmd === "project") return ["workspace", "base", "lanes", "allow-lanes", "parallel", "always-temp", "wait-parent-pr", "code"].some(flag => parsed.flag(flag) !== undefined);
  if (["compact-events", "vacuum"].includes(parsed.cmd)) return parsed.flag("apply") === "true";
  if (parsed.cmd === "native-sessions") return ["apply", "restore", "restore-manifest", "reset-failed"].some(flag => parsed.flag(flag) !== undefined);
  return true;
}

function auditCommand(parsed: ParsedArgs, env: NodeJS.ProcessEnv, work: (identity: Identity) => Promise<unknown> | unknown): Promise<unknown> {
  let identity: Identity;
  try { identity = resolveCliIdentity(env); }
  catch (err) {
    if (!commandWrites(parsed)) throw err;
    return auditWrite(parsed.cmd, { role: "unauthenticated", taskId: null, agentId: null }, () => { throw err; });
  }
  return commandWrites(parsed) ? auditWrite(parsed.cmd, identity, () => work(identity)) : Promise.resolve(work(identity));
}

/** Preserve token-free command identity; a terminal does not need a supervisor credential. */
function readonlyCommandIdentity(env: NodeJS.ProcessEnv): Identity {
  const readonly = openReadonlyDb();
  try { return resolveCompactIdentity(env, readonly); }
  finally { readonly.close(); }
}

/** Maintenance must back up the untouched old schema before any writable getDb()/audit. */
async function auditMaintenance(parsed: ParsedArgs, env: NodeJS.ProcessEnv, work: () => unknown): Promise<unknown> {
  const identity = readonlyCommandIdentity(env);
  let result: unknown;
  try { result = work(); }
  catch (err) { return auditWrite(parsed.cmd, identity, () => { throw err; }); }
  return auditWrite(parsed.cmd, identity, () => result);
}

export function runKanban(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  hooks?: KanbanHooks,
): Promise<unknown> {
  return withWriteTransport("cli", () => runKanbanInternal(argv, env, hooks));
}

async function runKanbanInternal(
  argv: string[],
  env: NodeJS.ProcessEnv,
  hooks?: KanbanHooks,
): Promise<unknown> {
  const parsed = parseKanbanArgs(argv);
  if (wantsHelp(argv) || parsed.cmd === "help" || parsed.cmd === "--help" || parsed.cmd === "-h") return kanbanHelp();
  assertKnownArgs(parsed);
  if (parsed.cmd === "ping") return { text: "kanban-pong" };
  // DEMO_0001: a missing or broken config is never run on defaults here. Only doctor goes on, to report it.
  if (parsed.cmd !== "doctor") assertConfigReadable();
  if (parsed.cmd === "audit") {
    if (hooks?.auditView) {
      const report = await performAudit(hooks.auditView);
      return parsed.json ? report : formatAudit(report);
    }
    const url = env.PASEO_URL ?? "ws://127.0.0.1:6767/ws";
    const client = createPaseoClient({ url, reconnect: { enabled: false }, connectTimeoutMs: 8_000 });
    await client.connect();
    try {
      const report = await performAudit(auditView(client));
      return parsed.json ? report : formatAudit(report);
    } finally {
      await client.close();
    }
  }
  if (parsed.cmd === "native-sessions") {
    const work = () => nativeSessionsCommand({ restore: parsed.flag("restore"), resetFailed: parsed.flag("reset-failed"), reconcileCodex: parsed.flag("reconcile-codex") === "true", reconcileClaude: parsed.flag("reconcile-claude") === "true", includeTmpSessions: parsed.flag("include-tmp-sessions") === "true", restoreManifest: parsed.flag("restore-manifest"), sweep: parsed.flag("sweep") === "true", apply: parsed.flag("apply") === "true", dryRun: parsed.flag("dry-run") === "true", project: parsed.flag("project"), limit: parsed.flag("limit") == null ? undefined : Number(parsed.flag("limit")), offset: parsed.flag("offset") == null ? undefined : Number(parsed.flag("offset")) }, env, { progress: message => console.error(message) });
    return commandWrites(parsed) ? auditWrite(parsed.cmd, readonlyCommandIdentity(env), work) : work();
  }
  if (parsed.cmd === "compact-events") {
    const apply = parsed.flag("apply") === "true" && parsed.flag("dry-run") !== "true";
    const rawDays = parsed.flag("days");
    const retentionDays = rawDays == null ? DEFAULT_RETENTION_DAYS : Number(rawDays);
    const work = () => compactVerifyEvents({ apply, env, retentionDays });
    return apply ? auditMaintenance(parsed, env, work) : work();
  }
  if (parsed.cmd === "vacuum") {
    const apply = parsed.flag("apply") === "true" && parsed.flag("dry-run") !== "true";
    const work = () => vacuumKanbanDb({ apply, env });
    return apply ? auditMaintenance(parsed, env, work) : work();
  }
  if (parsed.cmd === "doctor") {
    if (parsed.flag("last") != null) {
      const last = readLastDoctorReport();
      if (!last) return parsed.json ? { text: t("tools.noDoctorReport") } : t("tools.noDoctorReport");
      return parsed.json ? last : formatDoctor(last);
    }
    const report = hooks?.doctorSources
      ? await runDoctor({ sources: hooks.doctorSources, wake: false, persist: true })
      : await (async () => {
          const settings = doctorSettings(loadConfigForReport());
          const deadline = Date.now() + settings.totalTimeoutMs;
          const sources = await connectAndCollect(env, deadline);
          const left = Math.max(1, deadline - Date.now());
          return runDoctor({ sources, wake: false, persist: true, settings: { ...settings, totalTimeoutMs: left } });
        })();
    return parsed.json ? report : formatDoctor(report);
  }
  return auditCommand(parsed, env, identity => runAuthenticatedCommand(parsed, env, identity, hooks));
}

async function runAuthenticatedCommand(parsed: ParsedArgs, env: NodeJS.ProcessEnv, identity: Identity, hooks?: KanbanHooks): Promise<unknown> {
  assertCliCommandAllowed(identity, parsed.cmd);
  if (parsed.cmd === "supervise") {
    const project = parsed.flag("project")?.trim() ?? "";
    if (!project) throw new KanbanError("invalid", t("cli.supervise.needProject"));
    if (!env.PASEO_AGENT_ID?.trim()) throw new KanbanError("forbidden", t("cli.supervise.needAgent"));
    return superviseProject(identity, project);
  }
  if (parsed.cmd === "handover") {
    return handoverLeader(identity, {
      project: parsed.flag("project"),
      to: parsed.flag("to") ?? "",
      from: parsed.flag("from"),
      dryRun: parsed.flag("dry-run") === "true",
      kanbanLeader: parsed.flag("kanban-leader") === "true",
    });
  }
  if (parsed.cmd === "project") {
    if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("cli.project.onlyLeader"));
    const requested = parsed.flag("project")?.trim() ?? "";
    const project = findConfiguredProject(requested) ?? requested;
    const workspace = parsed.flag("workspace")?.trim();
    const base = parsed.flag("base")?.trim();
    const lanesFlag = parsed.flag("lanes");
    const allowLanes = parsed.flag("allow-lanes");
    const parallelFlag = parsed.flag("parallel");
    const alwaysTempFlag = parsed.flag("always-temp");
    const waitParentPrFlag = parsed.flag("wait-parent-pr");
    const codeFlag = parsed.flag("code");
    const describe = (name: string) => {
      const stored = loadConfig().projects?.[name];
      const settings = projectWorkspace(name);
      const code = projectCode(name);
      const line = t("cli.project.line", {
        name,
        base: settings.baseBranch,
        lanes: settings.worktreeLanes,
        laneState: settings.lanesEnabled ? t("cli.project.lanesAllowed") : t("cli.project.lanesOff"),
        parallelState: settings.parallel === false ? t("cli.project.parallelOff") : t("cli.project.parallelOn"),
        code: code ? t("cli.project.code", { code }) : "",
        alwaysState: settings.alwaysTemp === true ? t("cli.project.alwaysTempOn") : t("cli.project.alwaysTempOff"),
        waitParentPr: settings.waitParentPr === false ? t("cli.project.off") : t("cli.project.on"),
      });
      return stored?.defaultWorkspace === "worktree" ? `${line}\n${retiredDefaultWorktree()}` : line;
    };
    if (!workspace && !base && lanesFlag === undefined && allowLanes === undefined && parallelFlag === undefined && alwaysTempFlag === undefined && waitParentPrFlag === undefined && codeFlag === undefined) {
      if (!project) {
        const projects = listProjectWorkspaces();
        const lines = Object.keys(projects).sort().map((name) => describe(name));
        const text = lines.length > 0 ? lines.join("\n") : t("cli.project.noneConfigured");
        return { text, projects, note: t("cli.project.unconfiguredNote") };
      }
      const settings = projectWorkspace(project);
      return { text: describe(project), project, ...settings, waitParentPr: settings.waitParentPr !== false };
    }
    if (!project) throw new KanbanError("invalid", t("cli.project.needProject"));
    assertProjectSettingsScope(identity, project);
    if (workspace === "worktree") throw new KanbanError("invalid", retiredDefaultWorktree());
    if (workspace && workspace !== "dir") throw new KanbanError("invalid", t("config.workspaceOnlyDir"));
    let worktreeLanes: number | undefined;
    if (lanesFlag !== undefined) {
      const n = Number(lanesFlag);
      if (!Number.isInteger(n) || n < 1 || n > 32) throw new KanbanError("invalid", t("config.badLaneCount"));
      worktreeLanes = n;
    }
    let lanesEnabled: boolean | undefined;
    if (allowLanes !== undefined) {
      if (allowLanes !== "on" && allowLanes !== "off") throw new KanbanError("invalid", t("cli.project.onOff.allowLanes"));
      lanesEnabled = allowLanes === "on";
    }
    let parallel: boolean | undefined;
    if (parallelFlag !== undefined) {
      if (parallelFlag !== "on" && parallelFlag !== "off") throw new KanbanError("invalid", t("cli.project.onOff.parallel"));
      parallel = parallelFlag === "on";
    }
    let alwaysTemp: boolean | undefined;
    if (alwaysTempFlag !== undefined) {
      if (alwaysTempFlag !== "on" && alwaysTempFlag !== "off") throw new KanbanError("invalid", t("cli.project.onOff.alwaysTemp"));
      alwaysTemp = alwaysTempFlag === "on";
    }
    let waitParentPr: boolean | undefined;
    if (waitParentPrFlag !== undefined) {
      if (waitParentPrFlag !== "on" && waitParentPrFlag !== "off") throw new KanbanError("invalid", t("cli.project.onOff.waitParentPr"));
      waitParentPr = waitParentPrFlag === "on";
    }
    // Checked before anything is saved, so a refused code leaves the other settings untouched too.
    if (codeFlag !== undefined) assertCodeNotShown(project, codeFlag);
    if (workspace || base || worktreeLanes !== undefined || lanesEnabled !== undefined || parallel !== undefined || alwaysTemp !== undefined || waitParentPr !== undefined) {
      setProjectWorkspace(project, {
        ...(workspace ? { defaultWorkspace: "dir" as const } : {}),
        ...(base ? { baseBranch: base } : {}),
        ...(worktreeLanes !== undefined ? { worktreeLanes } : {}),
        ...(lanesEnabled !== undefined ? { lanesEnabled } : {}),
        ...(parallel !== undefined ? { parallel } : {}),
        ...(alwaysTemp !== undefined ? { alwaysTemp } : {}),
        ...(waitParentPr !== undefined ? { waitParentPr } : {}),
      });
    }
    if (codeFlag !== undefined) setProjectCode(project, codeFlag);
    const settings = projectWorkspace(project);
    return { ok: true, text: describe(project), project, ...settings, waitParentPr: settings.waitParentPr !== false };
  }
  if (parsed.cmd === "rebind") {
    if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("cli.onlyLeader.rebind"));
    const agentId = parsed.flag("agent")?.trim() ?? "";
    if (!agentId) throw new KanbanError("invalid", t("cli.rebind.needAgent"));
    assertSafeAgentId(agentId, "--agent");
    const taskId = resolveTaskId(parsed.positionals[0] ?? parsed.flag("id") ?? "");
    assertSupervisorScope(identity, getTask(taskId), t("cli.action.rebind"));
    assertNotLeaderAgent(agentId);
    const presence = hooks?.agentPresence ? await hooks.agentPresence(agentId) : await livePresence(agentId, env);
    return rebindTask(taskId, agentId, presence);
  }
  if (parsed.cmd === "purge-agents") {
    if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("cli.onlyLeader.purge"));
    const taskId = resolveTaskId(parsed.positionals[0] ?? parsed.flag("id") ?? "");
    assertSupervisorScope(identity, getTask(taskId), t("cli.action.purge"));
    const dryRun = parsed.flag("dry-run") === "true";
    const result = await purgeCardAgents(taskId, { dryRun });
    return { text: result.text, deleted: result.deleted, dryRun };
  }
  if (parsed.cmd === "resume-cleanup") {
    if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("cli.onlyLeader.resumeCleanup"));
    const taskId = resolveTaskId(parsed.positionals[0] ?? parsed.flag("id") ?? "");
    assertSupervisorScope(identity, getTask(taskId), t("cli.action.resumeCleanup"));
    const resumedSteps = resumeCleanup(taskId);
    const requestId = resumedSteps === 0 ? requestRebuiltCleanup(taskId) : null;
    const requeued = requestId !== null;
    const resumed = resumedSteps + (requeued ? 1 : 0);
    return { requeued, requested: requeued, requestId, execution: requeued ? "periodic" : null,
      text: requeued ? t("cli.resumeCleanup.requested") : resumed === 0 ? t("cli.resumeCleanup.none") : t("cli.resumeCleanup.done", { count: resumed }), resumed };
  }
  const id = () => resolveTaskId(parsed.positionals[0] ?? parsed.flag("id") ?? "");
  if (parsed.cmd === "tag") {
    if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("cli.onlyLeader.tag"));
    const taskId = id();
    assertSupervisorScope(identity, getTask(taskId), t("cli.action.tag"));
    return addTaskTags(taskId, parsed.all("tag"), identity.role);
  }
  if (parsed.cmd === "start") {
    if (identity.role !== "supervisor") throw new KanbanError("forbidden", t("cli.onlyLeader.start"));
    assertSupervisorScope(identity, getTask(id()), t("cli.action.start"));
    const force = parsed.flag("force") === "true";
    if (hooks?.launcher) return await startTask(id(), hooks.launcher, "supervisor", { ...hooks.startReaders, force });
    const url = env.PASEO_URL ?? process.env.PASEO_URL ?? "ws://127.0.0.1:6767/ws";
    const client = createPaseoClient({ url, reconnect: { enabled: false } });
    await client.connect();
    try {
      return await startTask(id(), launcherFrom(client), "supervisor", { force });
    } finally {
      await client.close();
    }
  }
  const command = parsed.cmd.replace(/-/g, "_");
  const tool = command.startsWith("kanban_") ? command : `kanban_${command}`;
  const args: Record<string, unknown> = {
    id: parsed.positionals[0] ?? parsed.flag("id"),
    project: parsed.flag("project"),
    scope: parsed.flag("scope"),
    title: parsed.flag("title"),
    role: parsed.flag("role"),
    workspace: parsed.flag("workspace"),
    contract: parsed.flag("contract"),
    profile: parsed.flag("profile"),
    maxRetries: parsed.flag("max-retries"),
    tags: parsed.all("tag"),
    effort: parsed.flag("effort"),
    tier: parsed.flag("tier"),
    reviews: parsed.flag("reviews"),
    decision: parsed.flag("decision"),
    summary: parsed.flag("summary"),
    reason: parsed.flag("reason"),
    artifact: parsed.flag("artifact"),
    note: parsed.flag("note"),
    countRound: parsed.flag("count-round") === "true",
    findings: parsed.flag("findings"),
    kind: parsed.flag("kind"),
    parent: parsed.flag("parent"),
    parents: parentIdsFromFlags(parsed),
    text: parsed.flag("text") ?? parsed.positionals.slice(1).join(" "),
    handoff: parsed.flag("handoff"),
    onBehalf: parsed.flag("on-behalf") === "true",
    agent: parsed.flag("agent"),
    provider: parsed.flag("provider"),
    model: parsed.flag("model"),
    thinking: parsed.flag("thinking"),
    family: parsed.flag("family"),
    idempotency: parsed.flag("idempotency"),
    brief: parsed.flag("brief-file")
      ? `${t("cli.briefSource", { path: parsed.flag("brief-file") as string })}\n\n${readBriefFile(parsed.flag("brief-file") as string, identity.role, process.cwd(), briefFileTemporaryRoots(parsed.flag("project")))}`
      : parsed.flag("brief"),
  };
  return handleTool(tool, args, env.KANBAN_TOKEN?.trim() || null, identity, {
    agentPresence: hooks?.agentPresence ?? ((agentId) => livePresence(agentId, env)),
  });
}

async function main(): Promise<void> {
  applyServerLanguage();
  const parsed = parseKanbanArgs(process.argv.slice(2));
  print(parsed.json, await runKanban(process.argv.slice(2)));
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  main().catch((err) => {
    const payload = err instanceof KanbanError ? err.toJSON() : { ok: false, message: err instanceof Error ? err.message : String(err) };
    if (process.argv.includes("--json")) console.error(JSON.stringify(payload));
    else console.error(payload && typeof payload === "object" && "message" in payload ? String(payload.message) : String(err));
    process.exit(1);
  });
}
