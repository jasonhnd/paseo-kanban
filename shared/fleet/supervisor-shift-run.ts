// The manual shift, one function per stage. Nothing here talks to Paseo: every side effect goes through ShiftPorts.
// Stages: queue (wait for the old session to finish talking) -> handover -> open the new session (or re-attach)
// -> detach -> wait for the taken-over reply -> archive. Each stage either hands back a value or the outcome that stops the shift.
import { t } from "./i18n";
import { isShiftBlocked, shouldStartShift, takeoverPrompt } from "./supervisor-shift-format";
import {
  cancelledLabel,
  handoverAsk,
  handoverDoneReply,
  HANDOVER_TIMEOUT_MS,
  PARENT_LABEL,
  phaseLabel,
  queueDetail,
  QUEUE_POLL_MS,
  queueTimeoutDetail,
  QUEUE_TIMEOUT_MS,
  saysHandoverDone,
  saysTakenOver,
  takenOverReply,
  TAKEOVER_POLL_MS,
  TAKEOVER_TIMEOUT_MS,
  type ShiftAgent,
  type ShiftOutcome,
  type ShiftPhase,
  type ShiftPorts,
  type ShiftProgress,
  type ShiftRequest,
} from "./supervisor-shift-types";

const ERROR_TEXT_MAX = 160;
/** Result text of a shift that cannot tell which session to archive. Tests and the log read it. */
export function oldIdLostResult(): string {
  return t("shift.result.oldIdLost");
}

/** Per-run state: the request, the ports, the steps taken so far, and the progress callback. */
interface ShiftRun {
  request: ShiftRequest;
  ports: ShiftPorts;
  steps: string[];
  tell(row: ShiftProgress): void;
}

type Stage<T> = { ok: true; value: T } | { ok: false; outcome: ShiftOutcome };

interface NewSession {
  newId: string;
  labels: Record<string, string>;
}

interface RowSpec {
  newId?: string | null;
  canContinue?: boolean;
  canCancel?: boolean;
}

interface FailSpec extends RowSpec {
  step?: string;
  detail: string;
  result: string;
  resumeNext?: "open" | "wait" | null;
  label?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  return String(error).slice(0, ERROR_TEXT_MAX);
}

function stop(outcome: ShiftOutcome): { ok: false; outcome: ShiftOutcome } {
  return { ok: false, outcome };
}

function progress(input: {
  phase: ShiftPhase;
  detail: string;
  project: string;
  code: string;
  oldId: string;
  newId: string | null;
  contextTokens: number | null;
  canContinue: boolean;
  canCancel?: boolean;
}): ShiftProgress {
  return {
    phase: input.phase,
    label: phaseLabel(input.phase),
    detail: input.detail,
    project: input.project,
    code: input.code,
    oldId: input.oldId,
    newId: input.newId,
    contextTokens: input.contextTokens,
    canContinue: input.canContinue,
    canCancel: input.canCancel === true,
    openAgentId: input.phase === "done" ? input.newId : null,
  };
}

function rowFor(
  run: ShiftRun,
  agent: Pick<ShiftAgent, "id" | "contextTokens">,
  phase: ShiftPhase,
  detail: string,
  spec: RowSpec = {},
): ShiftProgress {
  return progress({
    phase,
    detail,
    project: run.request.project,
    code: run.request.code,
    oldId: agent.id,
    newId: spec.newId ?? null,
    contextTokens: agent.contextTokens,
    canContinue: spec.canContinue === true,
    canCancel: spec.canCancel,
  });
}

/** Show a failed row and build the outcome that ends the shift on it. Nothing is archived. */
function fail(run: ShiftRun, agent: Pick<ShiftAgent, "id" | "contextTokens">, spec: FailSpec): ShiftOutcome {
  const base = rowFor(run, agent, "failed", spec.detail, spec);
  const row = spec.label ? { ...base, label: spec.label } : base;
  row.step = spec.step ?? run.steps.at(-1) ?? "preflight";
  run.tell(row);
  return { progress: row, result: spec.result, archived: false, steps: run.steps, resumeNext: spec.resumeNext ?? null };
}

function notClicked(run: ShiftRun): ShiftOutcome {
  const detail = t("shift.detail.notClicked");
  const row = rowFor(run, { id: run.request.agentId, contextTokens: null }, "failed", detail);
  return { progress: row, result: detail, archived: false, steps: run.steps, resumeNext: null };
}

function notFound(run: ShiftRun): ShiftOutcome {
  const gone = { id: run.request.agentId, contextTokens: null };
  return fail(run, gone, {
    detail: t("shift.detail.notFound"),
    result: t("shift.result.notFound"),
    newId: run.request.existingNewId,
  });
}

/** Await durable state before sending, opening, detaching or archiving. */
async function checkpoint(run: ShiftRun, row: ShiftProgress, step: string): Promise<void> {
  row.step = step;
  run.tell(row);
  await run.ports.checkpoint?.(row);
}

// ---- queue ----

/** Cancel or time-out ends the wait; null means keep waiting. `marked` says whether "queued" is already in steps. */
function queueStop(run: ShiftRun, agent: ShiftAgent, queuedAt: number, marked: boolean): ShiftOutcome | null {
  const reason = run.ports.cancelled?.()
    ? { detail: t("shift.detail.cancelled"), result: cancelledLabel(), canContinue: false, label: cancelledLabel() }
    : run.ports.now() - queuedAt >= QUEUE_TIMEOUT_MS
      ? { detail: queueTimeoutDetail(), result: t("shift.result.queueTimeout"), canContinue: true }
      : null;
  if (!reason) return null;
  const outcome = fail(run, agent, reason);
  if (!marked) run.steps.push("queued");
  return outcome;
}

async function waitInQueue(run: ShiftRun, first: ShiftAgent): Promise<Stage<ShiftAgent>> {
  const queuedAt = run.request.queuedAt ?? run.ports.now();
  const wait = run.ports.sleep ?? defaultSleep;
  let agent = first;
  let marked = false;
  while (isShiftBlocked(agent)) {
    const stopped = queueStop(run, agent, queuedAt, marked);
    if (stopped) return stop(stopped);
    await checkpoint(run, rowFor(run, agent, "queued", queueDetail(), { canCancel: true }), "queue");
    if (!marked) {
      run.steps.push("queued");
      marked = true;
    }
    await wait(QUEUE_POLL_MS);
    const next = await run.ports.getAgent(agent.id);
    if (!next) {
      return stop(
        fail(run, agent, { detail: t("shift.detail.queueGone"), result: t("shift.result.notFound") }),
      );
    }
    agent = next;
  }
  return { ok: true, value: agent };
}

async function queueIfBusy(run: ShiftRun, agent: ShiftAgent): Promise<Stage<ShiftAgent>> {
  if (run.request.resume !== "start" || !isShiftBlocked(agent)) return { ok: true, value: agent };
  return waitInQueue(run, agent);
}

// ---- handover ----

function sendFailed(run: ShiftRun, agent: ShiftAgent, why: string): ShiftOutcome {
  return fail(run, agent, { detail: t("shift.detail.sendFailed", { why }), result: t("shift.result.sendFailed"), canContinue: true });
}

/** Ask the old session to write the handover. Null means it replied with the handover-done phrase. */
async function requestHandover(run: ShiftRun, agent: ShiftAgent): Promise<ShiftOutcome | null> {
  await checkpoint(run, rowFor(run, agent, "handover", t("shift.detail.askingHandover", { done: handoverDoneReply() })), "handover");
  run.steps.push("handover");
  let sent: Awaited<ReturnType<ShiftPorts["sendAndWait"]>>;
  try {
    sent = await run.ports.sendAndWait(agent.id, handoverAsk(), HANDOVER_TIMEOUT_MS);
  } catch (error) {
    return sendFailed(run, agent, errorText(error));
  }
  if (sent.error) return sendFailed(run, agent, sent.error.slice(0, ERROR_TEXT_MAX));
  if (!sent.timedOut && saysHandoverDone(sent.reply ?? "")) return null;
  const done = handoverDoneReply();
  return fail(run, agent, {
    detail: sent.timedOut ? t("shift.detail.handoverTimeout", { done }) : t("shift.detail.noHandoverReply", { done }),
    result: sent.timedOut ? t("shift.result.handoverTimeout") : t("shift.result.noHandoverReply", { done }),
    canContinue: true,
    resumeNext: "open",
  });
}

// ---- new session ----

/** Create the new session from the old one's settings. Throws when the port does. */
async function createSession(
  run: ShiftRun,
  agent: ShiftAgent,
  workspaceId: string,
  handover: { path: string; summary: string } | null,
): Promise<Awaited<ReturnType<ShiftPorts["createAgent"]>>> {
  // Re-read after the old session's handover, including when continuing after a timeout.
  const acceptanceCards = (await run.ports.readAcceptanceCards?.(run.request.project).catch(() => null)) ?? null;
  return run.ports.createAgent({
    idempotencyKey: run.request.creationKey ?? `afc-leader-swap:${run.request.project}:${agent.id}`,
    labels: Object.fromEntries(Object.entries(agent.labels).filter(([key]) => key !== PARENT_LABEL)),
    workspaceId,
    cwd: agent.cwd,
    title: agent.title,
    provider: agent.provider,
    model: agent.model,
    modeId: agent.modeId,
    thinkingOptionId: agent.thinkingOptionId,
    featureValues: agent.featureValues,
    prompt: takeoverPrompt({
      projectLabel: run.request.code,
      oldId: agent.id,
      handoverPath: handover?.path ?? null,
      handoverSummary: handover?.summary ?? null,
      acceptanceCards,
    }),
  });
}

async function openNewSession(run: ShiftRun, agent: ShiftAgent): Promise<Stage<NewSession>> {
  const workspaceId = agent.workspaceId;
  if (!workspaceId) {
    return stop(fail(run, agent, { step: "open", detail: t("shift.detail.noWorkspace"), result: t("shift.result.noWorkspace") }));
  }
  if (!agent.provider || !agent.model) {
    return stop(fail(run, agent, { step: "open", detail: t("shift.detail.noModel"), result: t("shift.result.noModel") }));
  }
  // A missing handover file only thins the takeover message; it must not stop the shift.
  const handover = agent.cwd ? await run.ports.readHandover(agent.cwd).catch(() => null) : null;
  await checkpoint(run, rowFor(run, agent, "opening", t("shift.detail.opening")), "open");
  run.steps.push("open");
  let created: Awaited<ReturnType<ShiftPorts["createAgent"]>>;
  try {
    created = await createSession(run, agent, workspaceId, handover);
  } catch (error) {
    return stop(fail(run, agent, { detail: t("shift.detail.openFailed", { error: errorText(error) }), result: t("shift.result.openFailed"), canContinue: true, resumeNext: "open" }));
  }
  await checkpoint(run, rowFor(run, agent, "opening", t("leader.swap.opened"), { newId: created.id }), "open");
  if (created.workspaceId !== workspaceId) {
    const detail = t("shift.detail.wrongWorkspace", { workspace: created.workspaceId });
    return stop(fail(run, agent, { detail, result: t("shift.result.wrongWorkspace"), newId: created.id }));
  }
  return { ok: true, value: { newId: created.id, labels: created.labels } };
}

/** resume "wait": the new session already exists, only its labels are needed. */
async function reattachSession(run: ShiftRun, agent: ShiftAgent): Promise<Stage<NewSession>> {
  const newId = run.request.existingNewId;
  if (!newId) return stop(fail(run, agent, { step: "wait", detail: t("shift.detail.noNewSession"), result: t("shift.result.noNewSession") }));
  await checkpoint(run, rowFor(run, agent, "waiting", t("shift.detail.waiting", { taken: takenOverReply() }), { newId }), "wait");
  const fresh = await run.ports.getAgent(newId);
  if (!fresh || !fresh.workspaceId || !agent.workspaceId) return stop(fail(run, agent, {
    step: "wait",
    detail: t(!fresh ? "shift.detail.sessionUnreadable" : "shift.detail.workspaceUnreadable", { newId }),
    result: t("shift.result.recheckFailed"),
    newId,
    canContinue: true,
    resumeNext: "wait",
  }));
  if (fresh.workspaceId !== agent.workspaceId) return stop(fail(run, agent, { step: "wait", detail: t("shift.detail.wrongWorkspace", { workspace: fresh.workspaceId }), result: t("shift.result.wrongWorkspace"), newId }));
  return { ok: true, value: { newId, labels: fresh.labels } };
}

// ---- detach, takeover, archive ----

/** Unlink the new session from the old one so archiving the old one does not take it along. */
async function detachIfParented(run: ShiftRun, agent: ShiftAgent, session: NewSession): Promise<ShiftOutcome | null> {
  if (session.labels[PARENT_LABEL] !== agent.id) return null;
  const { newId } = session;
  await checkpoint(run, rowFor(run, agent, "detaching", t("shift.detail.detaching"), { newId }), "detach");
  run.steps.push("detach");
  try {
    await run.ports.detach(newId);
  } catch (error) {
    return fail(run, agent, {
      detail: t("shift.detail.detachFailed", { error: errorText(error) }),
      result: t("shift.result.detachFailed"),
      newId,
      canContinue: true,
      resumeNext: "wait",
    });
  }
  return null;
}

function isTaken(seen: { reply: string; registered: string | null }, newId: string): boolean {
  return saysTakenOver(seen.reply) && seen.registered === newId;
}

function notTakenOutcome(run: ShiftRun, agent: ShiftAgent, newId: string, replied: boolean): ShiftOutcome {
  const taken = takenOverReply();
  const why = replied ? t("shift.detail.takenNotRegistered", { taken }) : t("shift.detail.noTakenReply", { taken });
  return fail(run, agent, {
    detail: t("shift.detail.notTaken", { why }),
    result: t("shift.result.notTaken"),
    newId,
    canContinue: true,
    resumeNext: "wait",
  });
}

/** Poll until the new session says it has taken over and the registry points at it. Null means taken over. */
async function awaitTakeover(run: ShiftRun, agent: ShiftAgent, newId: string): Promise<ShiftOutcome | null> {
  await checkpoint(run, rowFor(run, agent, "waiting", t("shift.detail.waiting", { taken: takenOverReply() }), { newId }), "wait");
  run.steps.push("wait");
  const polls = run.request.maxPolls ?? Math.ceil(TAKEOVER_TIMEOUT_MS / TAKEOVER_POLL_MS);
  const sleep = run.ports.sleep ?? defaultSleep;
  let seen: { reply: string; registered: string | null } = { reply: "", registered: null };
  for (let i = 0; i < polls; i++) {
    try {
      const reply = (await run.ports.latestReply(newId)) ?? "";
      seen = { reply, registered: await run.ports.registeredSupervisor(run.request.project) };
    } catch (error) {
      return fail(run, agent, {
        detail: t("shift.detail.recheckFailed", { error: errorText(error) }),
        result: t("shift.result.recheckFailed"),
        newId,
        canContinue: true,
        resumeNext: "wait",
      });
    }
    if (isTaken(seen, newId)) return null;
    if (i < polls - 1) await sleep(TAKEOVER_POLL_MS);
  }
  return notTakenOutcome(run, agent, newId, saysTakenOver(seen.reply));
}

async function archiveOld(run: ShiftRun, agent: ShiftAgent, newId: string): Promise<ShiftOutcome> {
  await checkpoint(run, rowFor(run, agent, "waiting", t("leader.swap.archiving"), { newId }), "archive");
  run.steps.push("archive");
  try {
    await run.ports.archive(agent.id);
  } catch (error) {
    return fail(run, agent, {
      detail: t("shift.detail.archiveFailed", { error: errorText(error) }),
      result: t("shift.result.archiveFailed"),
      newId,
      canContinue: true,
      resumeNext: "wait",
    });
  }
  const done = rowFor(run, agent, "done", t("shift.detail.done"), { newId });
  done.step = "archive";
  run.tell(done);
  return { progress: done, result: t("shift.result.done"), archived: true, steps: run.steps, resumeNext: null };
}

/** The registry already points at the new session and the old id is gone from the queue and the log. Say so on the homepage. */
function oldIdLost(run: ShiftRun, agent: ShiftAgent, newId: string): ShiftOutcome {
  const which = agent.title ? t("shift.detail.oldTitled", { title: agent.title }) : t("shift.detail.oldSameTitle");
  return fail(run, agent, {
    detail: t("shift.detail.oldIdLost", { which, newId }),
    result: oldIdLostResult(),
    newId,
    canContinue: true,
    resumeNext: "wait",
  });
}

async function finishTakeover(run: ShiftRun, agent: ShiftAgent, session: NewSession): Promise<ShiftOutcome> {
  const { newId } = session;
  if (agent.id === newId && run.request.resume === "wait") return oldIdLost(run, agent, newId);
  if (agent.id === newId) {
    return fail(run, agent, {
      detail: t("shift.detail.sameId"),
      result: t("shift.result.sameId"),
      newId,
      canContinue: true,
      resumeNext: "wait",
    });
  }
  const detached = await detachIfParented(run, agent, session);
  if (detached) return detached;
  const waited = await awaitTakeover(run, agent, newId);
  if (waited) return waited;
  return archiveOld(run, agent, newId);
}

/**
 * Handover, then a new session in the same workspace, detach if it is parented on the old one,
 * wait until it says it has taken over and the registry points at it, then archive the old session.
 * Returns immediately when clicked is false, without calling any port.
 */
export async function runSupervisorShift(
  request: ShiftRequest,
  ports: ShiftPorts,
  onProgress?: (progress: ShiftProgress) => void,
): Promise<ShiftOutcome> {
  const run: ShiftRun = { request, ports, steps: [], tell: (row) => onProgress?.(row) };
  if (!shouldStartShift(request.clicked)) return notClicked(run);

  const first = await ports.getAgent(request.agentId);
  if (!first) return notFound(run);
  const queued = await queueIfBusy(run, first);
  if (!queued.ok) return queued.outcome;
  const agent = queued.value;

  if (request.resume === "start") {
    const stopped = await requestHandover(run, agent);
    if (stopped) return stopped;
  }
  const session = request.resume === "wait" ? await reattachSession(run, agent) : await openNewSession(run, agent);
  if (!session.ok) return session.outcome;
  return finishTakeover(run, agent, session.value);
}
