// Constants and shapes shared by the supervisor-shift modules, plus the shift texts (looked up at call time).
import type { LeaderThresholds } from "./leader-usage";
import { t, tAll, type MessageKey } from "./i18n";

export const HANDOVER_TIMEOUT_MS = 15 * 60 * 1000;
export const TAKEOVER_TIMEOUT_MS = 15 * 60 * 1000;
export const TAKEOVER_POLL_MS = 2_000;
/** While the old session is still talking, look again this often. */
export const QUEUE_POLL_MS = 5_000;
/** Stop waiting and say why. 30 minutes from the moment the user confirmed. */
export const QUEUE_TIMEOUT_MS = 30 * 60 * 1000;
/** A finished shift leaves the row after this. Failures leave the top line when the user retries or cancels. */
export const SHIFT_DONE_HOLD_MS = 10 * 60 * 1000;
export const HANDOVER_PREVIEW_LINES = 30;
export const PARENT_LABEL = "paseo.parent-agent-id";

/** Row detail while the old session is still talking. */
export function queueDetail(): string {
  return t("shift.queue.detail");
}

export function queueTimeoutDetail(): string {
  return t("shift.queue.timeoutDetail");
}

/** The phrase the old session answers with once the handover is written. Prompts use t(); replies are matched with tAll(). */
export function handoverDoneReply(): string {
  return t("shift.reply.handoverDone");
}

/** The phrase the new session answers with once it has taken over. */
export function takenOverReply(): string {
  return t("shift.reply.takenOver");
}

/** True when a reply contains the handover-done phrase in any language. */
export function saysHandoverDone(reply: string): boolean {
  return tAll("shift.reply.handoverDone").some((phrase) => reply.includes(phrase));
}

/** True when a reply contains the taken-over phrase in any language. */
export function saysTakenOver(reply: string): boolean {
  return tAll("shift.reply.takenOver").some((phrase) => reply.includes(phrase));
}

/** The prompt sent to the old session asking it to write the handover. */
export function handoverAsk(): string {
  return t("shift.handover.ask", { done: handoverDoneReply() });
}

/** Label of a cancelled shift. */
export function cancelledLabel(): string {
  return t("shift.phase.cancelled");
}

/** True for a cancelled label or result, in any language (stored shifts may be older). */
export function isCancelledLabel(text: string): boolean {
  return tAll("shift.phase.cancelled").includes(text);
}

export type Lamp = "green" | "yellow" | "red" | "unknown";

export interface SupervisorConfig {
  supervisorAgentId?: unknown;
  supervisors?: unknown;
  projects?: unknown;
}

export interface SupervisorSlot {
  project: string;
  code: string;
  agentId: string;
}

export interface SupervisorAgentView {
  id: string;
  status: string;
  createdAt: string | null;
  contextTokens: number | null;
  handoverPath: string | null;
  handoverPreview: string | null;
  found: boolean;
}

export interface SupervisorRow {
  project: string;
  code: string;
  agentId: string;
  contextTokens: number | null;
  contextText: string;
  startedText: string;
  todayText: string | null;
  /** Busy, idle or not listed, in the current language; see isBusyStatusText. */
  statusText: string;
  lamp: Lamp;
  lampText: string | null;
  highlight: boolean;
  handoverPath: string | null;
  handoverPreview: string | null;
  acceptanceCards: string[] | null;
  /** Set when this agent id is registered for several projects and belongs to another one. */
  proxyOf?: string;
}

export type ShiftPhase = "queued" | "handover" | "opening" | "detaching" | "waiting" | "done" | "failed";

export interface ShiftProgress {
  phase: ShiftPhase;
  step?: string;
  label: string;
  detail: string;
  project: string;
  code: string;
  oldId: string;
  newId: string | null;
  contextTokens: number | null;
  canContinue: boolean;
  /** Queue, or a shift restored after reload. The row shows Cancel. */
  canCancel: boolean;
  openAgentId: string | null;
}

export interface ShiftAgent {
  id: string;
  status: string;
  title: string;
  workspaceId: string | null;
  cwd: string;
  provider: string;
  model: string;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
  labels: Record<string, string>;
  contextTokens: number | null;
  /** True when this session is waiting on a permission. Absent means not waiting. */
  pendingApproval?: boolean;
}

export interface ShiftCreateInput {
  idempotencyKey?: string;
  labels?: Record<string, string>;
  workspaceId: string;
  cwd: string;
  title: string;
  provider: string;
  model: string;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
  prompt: string;
}

export interface ShiftPorts {
  /** Persist the stage before the next host mutation. */
  checkpoint?(progress: ShiftProgress): Promise<void>;
  now(): number;
  getAgent(id: string): Promise<ShiftAgent | null>;
  sendAndWait(id: string, prompt: string, timeoutMs: number): Promise<{ timedOut: boolean; reply: string | null; error: string | null }>;
  readHandover(cwd: string): Promise<{ path: string; preview: string; summary: string } | null>;
  readAcceptanceCards?(project: string): Promise<string[] | null>;
  createAgent(input: ShiftCreateInput): Promise<{ id: string; labels: Record<string, string>; workspaceId: string }>;
  detach(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  registeredSupervisor(project: string): Promise<string | null>;
  latestReply(id: string): Promise<string | null>;
  sleep?(ms: number): Promise<void>;
  /** Checked between queue polls. True means the user pressed Cancel. */
  cancelled?(): boolean;
}

export interface ShiftRequest {
  creationKey?: string;
  clicked: boolean;
  project: string;
  code: string;
  agentId: string;
  /** "start" from the beginning. "open" skips the handover wait. "wait" rechecks an existing new session. */
  resume: "start" | "open" | "wait";
  existingNewId: string | null;
  maxPolls?: number;
  /** When the user confirmed. A restored queue keeps the original clock so 30 minutes is not reset. */
  queuedAt?: number | null;
}

export interface ShiftOutcome {
  progress: ShiftProgress;
  result: string;
  archived: boolean;
  steps: string[];
  resumeNext: "open" | "wait" | null;
}

const PHASE_KEY = {
  queued: "shift.phase.queued",
  handover: "shift.phase.handover",
  opening: "shift.phase.opening",
  detaching: "shift.phase.opening",
  waiting: "shift.phase.waiting",
  done: "shift.phase.done",
  failed: "shift.phase.failed",
} as const satisfies Record<ShiftPhase, MessageKey>;

export function phaseLabel(phase: ShiftPhase): string {
  return t(PHASE_KEY[phase]);
}

export interface HandoffLogLine {
  at: string;
  project: string;
  oldId: string;
  newId: string | null;
  contextTokens: number | null;
  result: string;
}

export interface SupervisorPanel {
  thresholds?: LeaderThresholds;
  rows: SupervisorRow[];
  tasks: ShiftProgress[];
  handoffs: HandoffLogLine[];
}

export const EMPTY_SUPERVISOR_PANEL: SupervisorPanel = { rows: [], tasks: [], handoffs: [] };

export type ShiftResume = "queue" | "start" | "open" | "wait";

/** One in-progress shift, written outside git so a plugin reload can show it again. */
export interface StoredShift {
  creationKey?: string;
  events?: ShiftProgress[];
  eventsOffset?: number;
  progress: ShiftProgress;
  resume: ShiftResume;
  queuedAt: number | null;
}
