/// <reference types="node" />
import { createPolicyChannel, injectPolicyChannel, onPolicyPublished } from "../application/policy-snapshot";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInsights } from "./insights";
import { readAgentRecords } from "./records";
import { recordTurn } from "./ledger";
import { publishFromSnapshotFile } from "./dispatch";
import { setEarlyResetNotify } from "./early-reset";
import { buildUsage, updatePlan } from "./usage";
import { beginCursorConnect, disconnectCursor } from "./cursor-usage";
import { requestPoolRefreshNow, startPoolRefresh } from "./pool-refresh";
import type { PaseoApi } from "./paseo-api";
import { changesBoard, readBoardSnapshot, startSnapshotWarm } from "./snapshot-cache";
import { readClosedDecision, submitChange } from "./decide-change";
import { productionDecideDeps, submitDecision } from "./decide-reply";
import { productionLeaderReplyDeps, submitLeaderReply } from "./leader-reply";
import { KANBAN_CONFIG, performOverturn, setDecisionMaintEnabled, startDecisionMaintenance } from "./decisions-maint";
import { setSweepEnabled, startIdleSweep } from "./sweep";
import { beginCompatCheck, startCompatWatch } from "./upgrade-watch";
import { startDaemonWatch } from "./daemon-watch";
import { startCursorLoginWatch } from "./cursor-login";
import { startKeychainProbe } from "./keychain-probe";
import { readAccessView, refreshAccess, startAccessCheck } from "./access";
import { BIN, DECISIONS, logSwallowed, PASEO_DIR, run } from "./util";
import { dataDirChoice, describeDataDir } from "./paths";
import { applyServerLanguage } from "../language";
import { language, t } from "../../shared/fleet/i18n";
import { startContractExports } from "./exports";
import { agentLinkRpc, boardInsightsRpc, boardSnapshotRpc, changeDecisionRpc, compatCheckRpc, decideReplyRpc, decisionMaintEnabledRpc, leaderReplyRpc, openAgentRpc, overturnDecisionRpc, supervisorShiftRpc, sweepEnabledRpc } from "../../shared/fleet/board";
import { panelPrefsRpc } from "../../shared/fleet/panel-prefs";
import { accessRpc } from "../../shared/fleet/access";
import { doctorRpc } from "../../shared/fleet/doctor";
import { runDoctor } from "./doctor";
import { startDoctorDaily } from "./doctor-daily";
import { readPanelPrefs, updatePanelPrefs } from "./panel-prefs";
import { leaderSwapRpc, leaderUsageRpc } from "../../shared/fleet/leader-command";
import { leaderSwap, readLeaderUsage } from "./leader-command";
import { requestSupervisorShift } from "./supervisor-shift";
import { boardUsageRpc, cursorConnectRpc, cursorDisconnectRpc, planUpdateRpc, resetCouponsRefreshRpc } from "../../shared/fleet/usage";
import { confirmResetCoupons, startResetCouponConfirm } from "./reset-coupons";
import { rolesPageRpc, rolesSetRpc } from "../../shared/fleet/roles-page";
import { buildRolesPageView, setRoleModel, undoRoleChange } from "./roles-page";
import { initializeSettings } from "./settings";
import { readSettingsWithDispatch, writeSettingsWithDispatch } from "./settings-dispatch";
import { configReadRpc, configWriteRpc } from "../../shared/fleet/settings";
import { discoverRolesRpc, previewRolesRpc } from "../../shared/fleet/profile-bootstrap";
import { discoverRoles, previewRoles } from "./profile-bootstrap";
import { rolesUndoRpc } from "../../shared/fleet/roles-history";

function registerFleet(server: PluginServerContext, currentHandle: () => PaseoApi | null) {
  // Plugin code only gets a Paseo handle inside handlers and hooks; remember the latest one for the timer.
  // Collectors use the single Kanban host binding. They never open another daemon connection.
  let paseoRef: PaseoApi | null = null;
  const remember = (paseo: PaseoApi) => {
    paseoRef = paseo;
  };
  // Decided once per process (server/paths.ts); say which directory this run reads and writes.
  console.log(`[afc] ${describeDataDir(dataDirChoice())}`);
  initializeSettings();
  applyServerLanguage();
  const cleanups: Array<() => void> = [];
  const own = (cleanup: () => void) => { cleanups.push(cleanup); return cleanup; };
  const dispose = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); setEarlyResetNotify(null); };
  try {
  const stopContractExports = own(startContractExports());
  const stopPoolRefresh = own(startPoolRefresh(() => currentHandle() ?? paseoRef, { allowOwnClient: false }));
  const stopSnapshotWarm = own(startSnapshotWarm(() => currentHandle() ?? paseoRef, undefined, undefined, false));
  void publishFromSnapshotFile().catch((error) => console.error("[afc] dispatch:", String(error).slice(0, 200)));
  const stopSweep = own(startIdleSweep());
  const stopCompat = own(startCompatWatch());
  const stopDaemonWatch = own(startDaemonWatch());
  const stopKeychainProbe = own(startKeychainProbe());
  const stopCursorLogin = own(startCursorLoginWatch());
  const stopAccessCheck = own(startAccessCheck());
  const stopDoctorDaily = own(startDoctorDaily());
  const notifySupervisor = async (agentId: string, text: string) => {
    await run(BIN.paseo, ["send", agentId, "--no-wait", "--prompt", text], 20_000);
  };
  setEarlyResetNotify(notifySupervisor);
  const stopDecisionMaint = own(startDecisionMaintenance(notifySupervisor));
  const stopResetCoupons = own(startResetCouponConfirm(() => currentHandle() ?? paseoRef, notifySupervisor));
  server.handle(configReadRpc, async ({ file }) => ({ ...await readSettingsWithDispatch(file), language: language() }));
  server.handle(discoverRolesRpc, async (_, { paseo }) => discoverRoles(paseo));
  server.handle(previewRolesRpc, async (input, { paseo }) => previewRoles(paseo, input));
  server.handle(configWriteRpc, async (input) => {
    const result = await changesBoard(writeSettingsWithDispatch(input));
    applyServerLanguage();
    result.snapshot.language = language();
    if (result.status === "saved") requestPoolRefreshNow();
    return result;
  });
  server.handle(leaderUsageRpc, async (_, { paseo }) => readLeaderUsage(paseo));
  server.handle(leaderSwapRpc, async (input, { paseo }) => leaderSwap(paseo, input));
  server.handle(doctorRpc, async () => runDoctor());
  server.handle(accessRpc, async ({ refresh }) => {
    if (refresh) await refreshAccess("now");
    return readAccessView();
  });
  server.handle(panelPrefsRpc, async (input) => {
    const prefs = input.fontStep === undefined && input.tab === undefined ? await readPanelPrefs() : await updatePanelPrefs(input);
    return { ...prefs, language: language() };
  });
  server.handle(boardSnapshotRpc, async ({ force }, { paseo }) => {
    remember(paseo);
    return readBoardSnapshot(paseo, Boolean(force));
  });
  server.handle(boardInsightsRpc, async ({ force }, { paseo }) => {
    remember(paseo);
    return buildInsights(paseo, Boolean(force));
  });
  server.handle(rolesPageRpc, async () => buildRolesPageView());
  server.handle(rolesSetRpc, async (input) => changesBoard(setRoleModel(input)));
  server.handle(rolesUndoRpc, async ({ id }) => changesBoard(undoRoleChange(id)));
  server.handle(openAgentRpc, async ({ agentId }) => {
    // Opening loads the agent; if its working directory is gone, Paseo can crash while starting the provider.
    const rec = (await readAgentRecords()).find((r) => r.id === agentId);
    if (rec && !existsSync(rec.cwd)) {
      return { ok: false, message: t("server.open.cwdMissing", { cwd: rec.cwd }) };
    }
    // `paseo agent open` resolves the agent's workspace on the daemon, so it works for agents the app has not loaded.
    try {
      const out = await run(BIN.paseo, ["agent", "open", agentId, "--json"], 15_000);
      return { ok: /"opened"/.test(out), message: out.trim().slice(0, 200) };
    } catch (e) {
      return { ok: false, message: String(e).slice(0, 200) };
    }
  });
  server.handle(agentLinkRpc, async ({ agentId }) => {
    // Deep link the Paseo app understands: /h/<server>/workspace/<workspace>?open=agent:<id>.
    // Works on the phone even when the app has not loaded that agent yet.
    const rec = (await readAgentRecords()).find((r) => r.id === agentId);
    if (!rec?.workspaceId) return { url: null, message: t("server.open.noWorkspace") };
    if (!existsSync(rec.cwd)) return { url: null, message: t("server.open.cwdMissing", { cwd: rec.cwd }) };
    let serverId = "";
    try {
      serverId = readFileSync(join(PASEO_DIR, "server-id"), "utf8").trim();
    } catch (error) {
      logSwallowed("read paseo server-id", error);
      serverId = "";
    }
    if (!serverId) return { url: null, message: t("server.open.noServerId") };
    const url = `paseo://h/${encodeURIComponent(serverId)}/workspace/${encodeURIComponent(rec.workspaceId)}?open=${encodeURIComponent(`agent:${agentId}`)}`;
    return { url, message: "" };
  });
  server.handle(sweepEnabledRpc, async ({ enabled }) => ({ enabled: await changesBoard(setSweepEnabled(enabled)) }));
  server.handle(decisionMaintEnabledRpc, async ({ enabled }) => ({ enabled: await changesBoard(setDecisionMaintEnabled(enabled)) }));
  server.handle(decideReplyRpc, async (input) => changesBoard(submitDecision(input, productionDecideDeps())));
  server.handle(changeDecisionRpc, async (input) => changesBoard(submitChange(input, { ...productionDecideDeps(), readClosed: readClosedDecision, now: Date.now })));
  server.handle(leaderReplyRpc, async (input) => changesBoard(submitLeaderReply(input, productionLeaderReplyDeps())));
  server.handle(overturnDecisionRpc, async ({ id }) => changesBoard(performOverturn({
    id,
    decisionsPath: DECISIONS,
    kanbanConfigPath: KANBAN_CONFIG,
    notify: notifySupervisor,
  })));
  server.handle(compatCheckRpc, async () => changesBoard(beginCompatCheck({ force: true })));
  server.handle(supervisorShiftRpc, async ({ project, action }, { paseo }) => {
    remember(paseo);
    try {
      const job = await changesBoard(requestSupervisorShift(paseo, project, action));
      return { ok: job.phase !== "failed", message: job.detail, job };
    } catch (error) {
      const detail = t("server.shift.notStarted", { error: String(error).slice(0, 160) });
      return {
        ok: false,
        message: detail,
        job: {
          phase: "failed" as const,
          label: t("shift.phase.failed"),
          detail,
          project,
          code: "",
          oldId: "",
          newId: null,
          contextTokens: null,
          canContinue: false,
          canCancel: false,
          openAgentId: null,
        },
      };
    }
  });
  server.handle(boardUsageRpc, async ({ period }, { paseo }) => {
    remember(paseo);
    return buildUsage(paseo, period);
  });
  server.handle(planUpdateRpc, async (input) => changesBoard(updatePlan(input)));
  server.handle(cursorConnectRpc, async () => changesBoard(beginCursorConnect()));
  server.handle(cursorDisconnectRpc, async () => changesBoard(disconnectCursor()));
  server.handle(resetCouponsRefreshRpc, async (_input, { paseo }) => {
    remember(paseo);
    return changesBoard(confirmResetCoupons(paseo, { force: true }));
  });
  return dispose;
  } catch (error) { dispose(); throw error; }
}

const SERVICE = Symbol.for("paseo-kanban.fleet-service");
/** Registration and every Fleet background loop have one owner for this plugin instance. */
export function createFleetService(server: PluginServerContext, handle: () => PaseoApi | null) {
  const policy = createPolicyChannel();
  let stop: (() => void) | null = null;
  let disposed = false;
  let releaseChannel = () => {}, releasePublisher = () => {};
  const service = {
    start(): void {
      if (disposed) throw new Error("Fleet service has been disposed");
      if (stop) return;
      const registry = globalThis as unknown as Record<symbol, typeof service | undefined>;
      registry[SERVICE]?.dispose();
      registry[SERVICE] = service;
      releaseChannel = injectPolicyChannel(policy);
      releasePublisher = onPolicyPublished(snapshot => policy.accept(snapshot));
      try { stop = registerFleet(server, handle); }
      catch (error) { service.dispose(); throw error; }
    },
    turn(...args: Parameters<typeof recordTurn>): void { recordTurn(...args); },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stop?.(); stop = null;
      releasePublisher(); releaseChannel(); policy.dispose();
      const registry = globalThis as unknown as Record<symbol, typeof service | undefined>;
      if (registry[SERVICE] === service) delete registry[SERVICE];
    },
  };
  return service;
}
