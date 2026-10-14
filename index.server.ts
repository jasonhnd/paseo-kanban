/// <reference types="node" />
import { createFleetService } from "./server/fleet/service";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPaseoClient, type PaseoApi } from "@getpaseo/client";
import { setWakeSender } from "./server/bus";
import { SAFE_AGENT_ID } from "./server/agent-id";
import { loadConfig, logRetiredDefaultWorktrees, setProjectAutoStart } from "./server/config";
import { isProjectMain } from "./server/placement";
import { leaderOptions, leaderStatus, previewLeader, recoverLeader, startLeader, type LeaderStartHost } from "./server/leader-start";
import { leaderOptionsRpc, leaderPreviewRpc, leaderRecoverRpc, leaderStartRpc, leaderStatusRpc } from "./shared/leader-start";
import { changeKanbanLeader, changeProjectLeader } from "./server/leader-registry";
import { decisionBoardExtras } from "./server/decisions";
import { installCleanup } from "./server/cleanup";
import { startTask } from "./server/dispatch";
import { checkSchedulerIdle, currentSchedulerIdleNote } from "./server/liveness";
import { bindScheduler } from "./server/loop";
import { askPaseoAgent, cleanupOps, launcherFrom, listActivePaseoAgents, listPaseoWorkspaces, readAgentActivity, readAgentEndNote } from "./server/paseo";
import { createStartupReconciler } from "./server/startup-orphans";
import { readAgentPresence, settleCanceledTurn } from "./server/presence";
import { startEarlyBind } from "./server/early-bind";
import { cardMark, lookupCard } from "./server/card-ref";
import { KanbanError } from "./server/errors";
import { applyFailure, classifyFailure, reclaimTask } from "./server/failures";
import { readReclaimContext } from "./server/reclaim-note";
import { applyNudge } from "./server/flow";
import { createLifecycleHooks } from "./server/lifecycle-hooks";
import { createHookBinding } from "./server/hook-binding";
import { hookObjects, refreshHookObjects, watchHookObjects } from "./server/hook-objects";
import { startMcpServer } from "./server/mcp";
import { markRunningMcpStale, mcpNoteFor, preferredMcpPort, recordMcpListen } from "./server/mcp-port";
import { settleOpeningLoginBlip } from "./server/login-blip";
import { lastUserMessageAtOf, planTurn } from "./server/nudge";
import { agentLink, agentLiveness, directoryForProject, findAgentFile, listAgentChoices, openAgent } from "./server/open";
import { loadPanelPrefs, readBoardTab, savePanelPrefs, saveBoardTab } from "./server/panel-prefs";
import { projectRows } from "./server/project-rows";
import { describeDataDir } from "./server/paths";
import { startExports } from "./server/exports";
import { primeCliEnv } from "./server/inject";
import { decidePermission } from "./server/permissions";
import { permissionContext } from "./server/permission-context";
import { readProfiles } from "./server/profiles";
import { startMissingCwdPatrol } from "./server/missing-cwd";
import { boardExtras } from "./server/schedule";
import { kanbanFallbackNote, notifySupervisorRegistered, supervisorRegisterBlock, supervisorView } from "./server/supervisor";
import { addComment, appendEvent, archiveTask, boardSnapshot, createTask, getDetail, getTask, listHistory, setTaskTier, unblockTask } from "./server/store";
import { parseTier } from "./server/tier";
import { getDb } from "./server/db";
import { toolDefs, formatResult, handleTool } from "./server/tools";
import { ensureSupervisorToken } from "./server/tokens";
import { boardTabRpc, panelPrefsRpc } from "./shared/panel-prefs";
import { doctorReds } from "./server/doctor-board";
import { round, stage, startPerfReporter } from "./server/perf";
import { readSettings, writeSettings } from "./server/settings";
import { agentLinkRpc, agentsRpc, archiveRpc, autoStartRpc, boardRpc, configReadRpc, configWriteRpc, decisionsRpc, fallbackSupervisorRpc, historyRpc, intakeRpc, openAgentRpc, resolveCardRpc, setTierRpc, startRpc, supervisorRpc, taskRpc, unblockRpc } from "./shared/rpc";
import "./server/wake";
import { UI_ACTOR } from "./shared/actors";
import { t } from "./shared/i18n";
import { applyServerLanguage } from "./server/language";

/** The doctor group must never take the rest of the board down with it. */
function safeDoctorReds(project: string | undefined): ReturnType<typeof doctorReds> {
  try {
    return doctorReds(project);
  } catch (err) {
    console.error("[paseo-kanban] board doctor reds", err instanceof Error ? err.message : err);
    return [];
  }
}

function fail(err: unknown): { ok: false; message: string } {
  if (err instanceof KanbanError) return { ok: false, message: err.message };
  return { ok: false, message: err instanceof Error ? err.message : String(err) };
}

export default function contribute(server: PluginServerContext) {
  console.log(`[paseo-kanban] ${describeDataDir()}; cwd ${process.cwd()}`);
  console.log(`[paseo-kanban] language ${applyServerLanguage()}`);
  logRetiredDefaultWorktrees();
  primeCliEnv();
  let supervisorToken: string | null = null;
  try {
    supervisorToken = ensureSupervisorToken();
  } catch (err) {
    console.error("[paseo-kanban] supervisor token", err instanceof Error ? err.message : err);
  }
  // Startup and scheduler-timer snapshots also cover bindings made by another CLI process.
  try {
    refreshHookObjects();
  } catch {
    console.error("[paseo-kanban] lifecycle identity snapshot unavailable; unknown events skipped");
  }
  let baseUrl = "";
  let close = async () => {};
  const ready = startMcpServer(
    toolDefs(),
    async (name, args, token) => {
      try {
        checkSchedulerIdle();
      } catch (err) {
        console.error("[paseo-kanban] scheduler idle", err instanceof Error ? err.message : err);
      }
      try {
        if (name === "kanban_ping") return { text: "kanban-pong" };
        const data = await handleTool(name, args, token);
        return { text: formatResult(data) };
      } catch (err) {
        const message = err instanceof KanbanError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
        return { text: message, isError: true };
      }
    },
    { preferredPort: preferredMcpPort() },
  ).then((mcp) => {
    baseUrl = mcp.url;
    close = mcp.close;
    try {
      recordMcpListen(mcp.port, mcp.replaced);
    } catch (err) {
      console.error("[paseo-kanban] mcp port file", err instanceof Error ? err.message : err);
    }
    if (mcp.replaced) markRunningMcpStale();
  });
  ready.catch((err) => {
    console.error("[paseo-kanban] mcp failed to start", err instanceof Error ? err.message : err);
  });





  const binding = createHookBinding(initializeBinding);
  const fleet = createFleetService(server, () => binding.current());
  try { fleet.start(); }
  catch (error) { void ready.finally(() => close()).catch(() => undefined); throw error; }
  let releaseCleanup = () => {};
  let cleanupBound = false;
  let stopEarlyBind = () => {};
  let earlyClient: { close: () => Promise<void> } | null = null;
  let identityClient: PaseoApi | null = null;
  let stopIdentityWatch = () => {};
  const reconcileStartup = createStartupReconciler({
    listAgents: () => {
      if (!binding.current()) throw new Error("startup reconciliation is not bound to Paseo yet");
      return listActivePaseoAgents(binding.current()!);
    },
    archiveAgent: (agentId) => {
      if (!binding.current()) throw new Error("startup reconciliation is not bound to Paseo yet");
      return binding.current()!.agents.ref(agentId).archive().then(() => undefined);
    },
  });
  const scheduler = bindScheduler({
    ready: () => {
      if (!binding.current()) return null;
      binding.activate();
      const paseo = binding.current()!;
      return {
        launcher: launcherFrom(paseo, reconcileStartup),
        send: (agentId: string, text: string) => paseo.agents.ref(agentId).send(text),
        agentActivity: (agentId: string) => readAgentActivity(paseo, agentId),
      };
    },
  });
  if (scheduler.reused) console.log("[paseo-kanban] scheduler reused");
  const kick = () => scheduler.kick();
  const bind = binding.bind;
  function initializeBinding(paseo: PaseoApi) {
    if (identityClient !== paseo) {
      stopIdentityWatch();
      identityClient = paseo;
      try {
        stopIdentityWatch = watchHookObjects(paseo, hookObjects, (message) => console.error(`[paseo-kanban] ${message}`));
      } catch {
        console.error("[paseo-kanban] lifecycle identity subscription unavailable");
      }
    }
    stopEarlyBind();
    releaseCleanup();
    releaseCleanup = installCleanup(cleanupOps(paseo), { keepSweepClock: cleanupBound });
    cleanupBound = true;
    setWakeSender((agentId, text) => paseo.agents.ref(agentId).send(text));
  }

  const hooks = createLifecycleHooks({
    hookObjects, bind, kick, permissionContext, console,
    schedulerReady: binding.ready, bindMemory: binding.bindMemory,
    createOptions: () => ({ baseUrl, supervisorToken, log: (message) => console.error(`[paseo-kanban] ${message}`) }),
    getDb, decidePermission, addComment, appendEvent, getTask, planTurn, lastUserMessageAtOf, readAgentPresence, settleCanceledTurn, askPaseoAgent, readAgentEndNote, settleOpeningLoginBlip, readProfiles, applyFailure, classifyFailure, reclaimTask, applyNudge, mcpNoteFor, readReclaimContext,
  });
  const removeBefore = server.before("agent.create", hooks.before);
  const removePermission = server.on("agent.permission_requested", hooks.permission);

  const removeTurn = server.on("agent.turn_ended", (event, context) => {
    fleet.turn(event.agent, event.timeline, context);
    return hooks.turn(event, context);
  });

  const removeArchived = server.on("agent.archived", hooks.archived);

  const removeCreated = server.on("agent.created", hooks.created);
  const removeWorkspace = server.on("workspace.created", hooks.workspace);

  const earlyBind = startEarlyBind({
    alreadyBound: binding.ready,
    async connect() {
      const client = createPaseoClient({
        url: process.env.PASEO_URL ?? "ws://127.0.0.1:6767/ws",
        reconnect: { enabled: false },
        connectTimeoutMs: 4000,
      });
      try {
        await client.connect();
        return client;
      } catch (err) {
        await client.close().catch(() => undefined);
        throw err;
      }
    },
    onBound(client) {
      earlyClient = client;
      bind(client);
      void kick();
      console.log("[paseo-kanban] scheduler bound at startup");
    },
    discard(client) {
      void client.close().catch(() => undefined);
    },
    log(message) {
      console.error("[paseo-kanban] early bind failed", message);
    },
  });
  stopEarlyBind = () => earlyBind.stop();

  const idleTimer = setInterval(() => {
    try {
      checkSchedulerIdle();
    } catch (err) {
      console.error("[paseo-kanban] scheduler idle", err instanceof Error ? err.message : err);
    }
  }, 60_000);
  const idleHandle = idleTimer as unknown as { unref?: () => void };
  idleHandle.unref?.();
  const stopPatrol = startMissingCwdPatrol();
  const stopPerf = startPerfReporter();
  const stopExports = startExports();

  function leaderHost(paseo: PaseoApi): LeaderStartHost {
    return {
      async workspaces(project) {
        const listed = await listPaseoWorkspaces(paseo);
        const directory = directoryForProject(project, listed);
        const mains = directory ? listed.filter((item) => isProjectMain(item, directory)) : [];
        return [...new Map(mains.map((item) => [item.directory!, { id: item.id, path: item.directory! }])).values()];
      },
      async create(input) {
        const handle = await paseo.workspaces.ref(input.workspaceId).agents.create({
          title: input.title,
          env: input.env,
          config: input.config,
          labels: { role: "supervisor", kanban: "leader", "kanban.leader-start": input.env.KANBAN_LEADER_START ?? "" },
        });
        return { id: handle.id };
      },
      async find(requestId) {
        const agents = await listActivePaseoAgents(paseo);
        const matches = agents.filter((agent) => agent.labels?.["kanban.leader-start"] === requestId);
        if (matches.length > 1) throw new KanbanError("conflict", t("leaderStart.error.multipleSessions"));
        return matches[0] ? { id: matches[0].id } : null;
      },
      send: (agentId, text) => paseo.agents.ref(agentId).send(text),
    };
  }
  server.handle(leaderOptionsRpc, (input, { paseo }) => leaderOptions(input.project, leaderHost(paseo)));
  server.handle(leaderPreviewRpc, (input, { paseo }) => previewLeader(input, leaderHost(paseo)));
  server.handle(leaderStartRpc, (input, { paseo }) => startLeader(input, leaderHost(paseo)));
  server.handle(leaderRecoverRpc, (input, { paseo }) => recoverLeader(input.project, leaderHost(paseo)));
  server.handle(leaderStatusRpc, (input, { paseo }) => leaderStatus(input.project, leaderHost(paseo)));

  server.handle(configReadRpc, (_input, { paseo }) => readSettings(() => listPaseoWorkspaces(paseo)));
  server.handle(configWriteRpc, (input, { paseo }) => writeSettings(input, () => listPaseoWorkspaces(paseo)));
  server.handle(panelPrefsRpc, async (input) => {
    if (input.fontStep === undefined) return loadPanelPrefs();
    return savePanelPrefs(input);
  });
  server.handle(boardTabRpc, async ({ tab }) => ({ tab: tab ? await saveBoardTab(tab) : await readBoardTab() }));
  server.handle(boardRpc, ({ project }, { paseo }) => round("rpc.board", () => {
    bind(paseo);
    void kick();
    try {
      checkSchedulerIdle();
    } catch (err) {
      console.error("[paseo-kanban] scheduler idle", err instanceof Error ? err.message : err);
    }
    const extras = stage("board.extras", () => boardExtras(project || undefined));
    const boss = extras.projectSupervisorId;
    const view = project
      ? stage("board.supervisorView", () => supervisorView(boss, boss ? findAgentFile(boss) : null))
      : { title: null, headline: t("server.leader.perProject"), prompt: null as string | null };
    const supervisorPrompt = project && !boss ? t("server.leader.missing") : view.prompt;
    return {
      ...stage("board.snapshot", () => boardSnapshot(project || undefined)),
      ...extras,
      projectRows: stage("board.projectRows", () => projectRows()),
      doctorReds: stage("board.doctorReds", () => safeDoctorReds(project || undefined)),
      supervisorHeadline: view.headline,
      supervisorPrompt,
      schedulerReady: binding.ready(),
      schedulerIdle: currentSchedulerIdleNote(),
    };
  }));
  server.handle(decisionsRpc, ({ project }) => round("rpc.decisions", () => ({
    ...decisionBoardExtras(loadConfig().supervisors, project || undefined),
    readAt: new Date().toISOString(),
  })));
  server.handle(resolveCardRpc, ({ code }) => lookupCard(code));
  server.handle(historyRpc, ({ project, query, offset, limit }) => round("rpc.history", () => listHistory({ project: project || undefined, query, offset, limit })));
  server.handle(taskRpc, ({ id }) => round("rpc.detail", () => getDetail(id)));
  server.handle(archiveRpc, ({ id }) => {
    try {
      archiveTask(id, UI_ACTOR);
      return { ok: true, message: t("server.archived", { card: cardMark(id) }) };
    } catch (err) {
      return fail(err);
    }
  });
  server.handle(unblockRpc, ({ id }) => {
    try {
      unblockTask(id, UI_ACTOR);
      return { ok: true, message: t("server.unblocked", { card: cardMark(id) }) };
    } catch (err) {
      return fail(err);
    }
  });
  server.handle(setTierRpc, ({ id, tier }) => {
    try {
      const value = parseTier(tier);
      setTaskTier(id, value, UI_ACTOR);
      return { ok: true, message: value ? t("server.tierSet", { tier: value }) : t("server.tierCleared") };
    } catch (err) {
      return fail(err);
    }
  });
  server.handle(startRpc, async ({ id }, { paseo }) => {
    bind(paseo);
    try {
      const result = await startTask(id, launcherFrom(paseo, reconcileStartup), UI_ACTOR);
      void kick();
      return { ok: true, message: result.message };
    } catch (err) {
      return fail(err);
    }
  });
  server.handle(intakeRpc, ({ project, text }, { paseo }) => {
    bind(paseo);
    try {
      const body = text.trim();
      const name = project.trim();
      if (!name || !body) return { ok: false, message: t("server.intake.empty") };
      const task = createTask({
        project: name,
        title: body.slice(0, 80),
        brief: body,
        role: "supervisor",
        initialStatus: "triage",
        actor: UI_ACTOR,
      });
      void kick();
      return { ok: true, message: t("server.intake.done", { card: cardMark(task.id) }) };
    } catch (err) {
      return fail(err);
    }
  });
  server.handle(autoStartRpc, ({ project, enabled }, { paseo }) => {
    bind(paseo);
    const name = project.trim();
    if (!name) return { ok: false, message: t("server.pickProject") };
    setProjectAutoStart(name, enabled);
    void kick();
    return { ok: true, message: enabled ? t("server.autoStartOn", { project: name }) : t("server.autoStartOff", { project: name }) };
  });
  server.handle(agentsRpc, async ({ project }, { paseo }) => {
    bind(paseo);
    const name = project?.trim() ?? "";
    if (!name) return { suggestedId: null, agents: [], note: t("server.agents.pickProject") };
    let listed: Awaited<ReturnType<typeof listPaseoWorkspaces>>;
    try {
      listed = await listPaseoWorkspaces(paseo);
    } catch (err) {
      console.error("[paseo-kanban] agents workspace list", err instanceof Error ? err.message : err);
      return { suggestedId: null, agents: [], note: t("server.agents.workspacesUnreadable") };
    }
    const directory = directoryForProject(name, listed);
    if (!directory) return { suggestedId: null, agents: [], note: t("server.agents.noMainWorkspace", { project: name }) };
    return { ...listAgentChoices(listed, directory), note: null };
  });
  server.handle(supervisorRpc, async ({ project, agentId }, { paseo }) => {
    bind(paseo);
    const name = project.trim();
    if (!name) return { ok: false, message: t("server.leader.pickProject") };
    const id = agentId.trim();
    if (id && !SAFE_AGENT_ID.test(id)) return { ok: false, message: t("server.badAgentId") };
    const block = id ? supervisorRegisterBlock(agentLiveness(id)) : null;
    if (block) return { ok: false, message: block };
    changeProjectLeader(name, id || null, { actor: UI_ACTOR, via: "ui" });
    const title = id ? findAgentFile(id)?.title?.trim() || id.slice(0, 8) : "";
    if (id) {
      try {
        await notifySupervisorRegistered(id, (target, text) => paseo.agents.ref(target).send(text));
      } catch (err) {
        console.error("[paseo-kanban] supervisor hint", err instanceof Error ? err.message : String(err));
        void kick();
        return { ok: true, message: t("server.leader.registeredNoNote", { title, project: name }) };
      }
    }
    void kick();
    return { ok: true, message: id ? t("server.leader.registered", { title, project: name }) : t("server.leader.cleared", { project: name }) };
  });
  server.handle(fallbackSupervisorRpc, async ({ agentId }, { paseo }) => {
    bind(paseo);
    const id = agentId.trim();
    if (id && !SAFE_AGENT_ID.test(id)) return { ok: false, message: t("server.badAgentId") };
    const block = id ? supervisorRegisterBlock(agentLiveness(id)) : null;
    if (block) return { ok: false, message: block };
    changeKanbanLeader(id || null, { actor: UI_ACTOR, via: "ui" });
    const title = id ? findAgentFile(id)?.title?.trim() || id.slice(0, 8) : "";
    if (id) {
      try {
        await paseo.agents.ref(id).send(kanbanFallbackNote());
      } catch (err) {
        console.error("[paseo-kanban] kanban supervisor hint", err instanceof Error ? err.message : String(err));
        void kick();
        return { ok: true, message: t("server.fallback.registeredNoNote", { title }) };
      }
    }
    void kick();
    return {
      ok: true,
      message: id ? t("server.fallback.registered", { title }) : t("server.fallback.cleared"),
    };
  });
  server.handle(openAgentRpc, ({ agentId }) => openAgent(agentId));
  server.handle(agentLinkRpc, ({ agentId }) => agentLink(agentId));

  return async () => {
    fleet.dispose();
    removeBefore();
    removePermission();
    removeTurn();
    removeArchived();
    removeCreated();
    removeWorkspace();
    clearInterval(idleTimer);
    stopPatrol();
    stopPerf();
    stopExports();
    stopIdentityWatch();
    scheduler.release();
    releaseCleanup();
    earlyBind.stop();
    if (earlyClient) await earlyClient.close().catch(() => undefined);
    await ready.catch(() => undefined);
    await close();
  };
}
