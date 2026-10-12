import { leaderThresholdsSchema } from "./leader-usage";
import { defineRpc } from "@getpaseo/plugin";
import { pausedProjectSchema } from "./paused";
import { z } from "zod";
import { homeViewSchema } from "./home-view";
import { leaderDetailSchema, LEADER_REPLY_LIMIT } from "./leader-panel";
import { t } from "./i18n";

/** `decide`: a pending decision from decisions.json or Kanban. `unread`: a finished <leader> reply the user has not opened. */
export const DECISION_KINDS = ["decide", "unread"] as const;

const supervisorRowSchema = z.object({
  project: z.string(),
  code: z.string(),
  agentId: z.string(),
  contextTokens: z.number().nullable(),
  contextText: z.string(),
  startedText: z.string(),
  todayText: z.string().nullable(),
  /** Display text: busy, idle, or not in the agent list (in the panel language). */
  statusText: z.string(),
  lamp: z.enum(["green", "yellow", "red", "unknown"]),
  lampText: z.string().nullable(),
  highlight: z.boolean(),
  handoverPath: z.string().nullable(),
  handoverPreview: z.string().nullable(),
  acceptanceCards: z.array(z.string()).nullable(),
  proxyOf: z.string().optional(),
});

export const shiftProgressSchema = z.object({
  step: z.string().optional(),
  phase: z.enum(["queued", "handover", "opening", "detaching", "waiting", "done", "failed"]),
  label: z.string(),
  detail: z.string(),
  project: z.string(),
  code: z.string(),
  oldId: z.string(),
  newId: z.string().nullable(),
  contextTokens: z.number().nullable(),
  canContinue: z.boolean(),
  canCancel: z.boolean(),
  openAgentId: z.string().nullable(),
});

const supervisorPanelSchema = z.object({
  thresholds: leaderThresholdsSchema.optional(),
  rows: z.array(supervisorRowSchema),
  details: z.array(leaderDetailSchema).optional(),
  tasks: z.array(shiftProgressSchema),
  handoffs: z.array(z.object({
    at: z.string(),
    project: z.string(),
    oldId: z.string(),
    newId: z.string().nullable(),
    contextTokens: z.number().nullable(),
    result: z.string(),
  })),
});

export const ROLE_ORDER = [
  "supervisor",
  "executor",
  "reviewer",
  "reader",
  "decision",
  "batch",
  "ops_vercel",
  "ops_cloudflare",
  "ops_github",
  "ops_notion",
] as const;

// ---------- fast snapshot (every 10 s) ----------

const poolStateSchema = z.object({
  dispatchable: z.boolean(),
  deprioritize: z.boolean(),
  prefer: z.boolean().optional(),
  reason: z.string(),
  usedPct: z.number().nullable(),
  pacePct: z.number().nullable().optional(),
  daysLeft: z.number().nullable().optional(),
  dailyPct: z.number().nullable().optional(),
  paceState: z.string().optional(),
});

const lineupSchema = z.object({
  name: z.string(),
  family: z.string().nullable(),
  model: z.string(),
  effort: z.string().nullable(),
  pool: z.string().nullable(),
  poolLabel: z.string(),
  status: z.enum(["prefer", "ready", "paused"]),
  statusText: z.string(),
  todayRuns: z.number(),
  poolState: poolStateSchema.nullable(),
});

const roleSchema = z.object({
  key: z.string(),
  name: z.string(),
  family: z.string().nullable(),
  provider: z.string(),
  modelId: z.string(),
  model: z.string(),
  detail: z.string(),
  pool: z.string().nullable(),
  poolState: poolStateSchema.nullable(),
  /** Every profile that can do this role, in the current dispatch order. */
  lineup: z.array(lineupSchema),
});

const agentSchema = z.object({
  id: z.string(),
  role: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  where: z.string(),
  project: z.string(),
  updatedAt: z.string().nullable(),
  source: z.enum(["paseo", "cursor-cloud"]),
});

const alertSchema = z.object({
  level: z.enum(["red", "yellow", "info"]),
  kind: z.string(),
  text: z.string(),
  agentId: z.string().nullable(),
});

const decisionSchema = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  detail: z.string(),
  blocking: z.boolean(),
  /** See DECISION_KINDS. */
  kind: z.enum(DECISION_KINDS),
  source: z.string(),
  createdAt: z.string(),
  agentId: z.string().nullable(),
  owner: z.string().optional(),
  delegated: z.boolean().optional(),
  leaderMissing: z.boolean().optional(),
  forceOpen: z.boolean().optional(),
});

/** An answer given on the panel less than 24 hours ago. It stays on the decisions list with "change answer" until the window ends. */
const recentChoiceSchema = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  detail: z.string(),
  letter: z.string(),
  doneAt: z.string(),
  blocking: z.boolean(),
  agentId: z.string().nullable(),
  source: z.string(),
  createdAt: z.string(),
});

const supervisorDecisionSchema = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  note: z.string(),
  decidedAt: z.string(),
});

const scheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  cadence: z.string(),
  target: z.string(),
  status: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastResult: z.string().nullable(),
  lastOutput: z.string(),
  /** Heartbeats that wake an existing agent: its title, and whether anyone under it is still working. */
  owner: z.string().nullable(),
  ownerId: z.string().nullable(),
  idle: z.boolean(),
});

const kanbanWaitSchema = z.object({
  id: z.number(),
  /** Display card number, `DEMO_0022` or `#111`. */
  code: z.string(),
  project: z.string(),
  title: z.string(),
  category: z.string(),
  reason: z.string(),
  waitedLabel: z.string(),
  agentId: z.string().nullable(),
  alarming: z.boolean(),
});

const kanbanSchema = z.object({
  /** absent: Kanban is not installed (no exports/kanban.json); the board folds and the sweep fold hide. */
  presence: z.enum(["absent", "stale", "fresh"]),
  available: z.boolean(),
  counts: z.array(z.object({ status: z.string(), label: z.string(), count: z.number() })),
  /** False when the queue columns cannot be read; the overview hides the waiting table and keeps the rest. */
  queueShown: z.boolean(),
  waiting: z.array(kanbanWaitSchema),
});

const changeSchema = z.object({ at: z.string(), role: z.string(), from: z.string(), to: z.string() });

const sweepEntrySchema = z.object({
  at: z.string(),
  agentId: z.string().nullable(),
  title: z.string(),
  cwd: z.string(),
  idleHours: z.number().nullable(),
  result: z.enum(["archived", "failed", "would_archive", "aborted"]),
  reason: z.string().nullable(),
});

const supervisorSchema = z.object({ id: z.string(), title: z.string(), project: z.string(), updatedAt: z.string().nullable() });

export const boardSnapshotRpc = defineRpc({
  name: "board.snapshot",
  input: z.object({ force: z.boolean().optional() }),
  output: z.object({
    generatedAt: z.string(),
    roles: z.array(roleSchema),
    agents: z.array(agentSchema),
    alerts: z.array(alertSchema),
    decisions: z.array(decisionSchema),
    supervisorDecisions: z.array(supervisorDecisionSchema),
    recentChoices: z.array(recentChoiceSchema),
    decisionMaint: z.object({ enabled: z.boolean() }),
    schedules: z.array(scheduleSchema),
    kanban: kanbanSchema,
    changes: z.array(changeSchema),
    /** cursor-agent version changes, newest last ("cursor-agent went from A to B"). */
    cursorNotes: z.array(z.object({ at: z.string(), text: z.string() })),
    sweep: z.object({ enabled: z.boolean(), entries: z.array(sweepEntrySchema) }),
    supervisors: z.array(supervisorSchema),
    warnings: z.array(z.string()),
    /** Crashes of the Paseo daemon since midnight in Tokyo. Zero until the log has been read. */
    daemonCrashesToday: z.number(),
    home: homeViewSchema,
    /** Each project's <leader>: context size, when it started, and any shift in progress. */
    supervisorPanel: supervisorPanelSchema,
    /** Projects the user paused. Their decisions are kept here, not in `decisions`, and are not counted anywhere. */
    pausedProjects: z.array(pausedProjectSchema.extend({ decisions: z.array(decisionSchema) })).optional(),
  }),
});

// ---------- slow insights (every 60 s, cached on the daemon) ----------

const prSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  author: z.string(),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
  ci: z.enum(["pass", "fail", "pending", "none"]),
  executorAgentId: z.string().nullable(),
  reviewerAgentId: z.string().nullable(),
  reviewVerdict: z.enum(["approve", "changes", "unknown", "none"]),
});

const sandboxAgentsSchema = z.object({
  /** False when Agent sandbox's local sidebar list can't be read (app not installed or format changed). */
  readable: z.boolean(),
  bots: z.array(z.object({ name: z.string(), repo: z.string().nullable(), lastActive: z.string().nullable() })),
});

const scoreSchema = z.object({
  role: z.string(),
  model: z.string(),
  runs: z.number(),
  errors: z.number(),
  interrupted: z.number(),
  avgMinutes: z.number().nullable(),
  followUps: z.number(),
  reviewsApproved: z.number(),
  reviewsChanges: z.number(),
});

const modelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  label: z.string(),
  thinking: z.array(z.string()),
  firstSeen: z.string(),
  isNew: z.boolean(),
  usedBy: z.array(z.string()),
});

const usageWindowSchema = z.object({ label: z.string(), usedPct: z.number().nullable(), resetsAt: z.string().nullable() });

const providerUsageSchema = z.object({
  provider: z.string(),
  plan: z.string().nullable(),
  status: z.string(),
  windows: z.array(usageWindowSchema),
  error: z.string().nullable(),
});

export const boardInsightsRpc = defineRpc({
  name: "board.insights",
  input: z.object({ force: z.boolean().optional() }),
  output: z.object({
    generatedAt: z.string(),
    unreviewedMerges: z.array(prSchema),
    sandboxAgents: sandboxAgentsSchema,
    scorecard: z.array(scoreSchema),
    models: z.array(modelSchema),
    modelsBaselineAt: z.string().nullable(),
    warnings: z.array(z.string()),
  }),
});

// ---------- actions ----------

export const openAgentRpc = defineRpc({
  name: "board.open-agent",
  input: z.object({ agentId: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const agentLinkRpc = defineRpc({
  name: "board.agent-link",
  input: z.object({ agentId: z.string() }),
  output: z.object({ url: z.string().nullable(), message: z.string() }),
});

export const sweepEnabledRpc = defineRpc({
  name: "board.sweep-enabled",
  input: z.object({ enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
});

export const decisionMaintEnabledRpc = defineRpc({
  name: "board.decision-maint-enabled",
  input: z.object({ enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
});

/** Close one decisions.json item from the homepage and notify that project's supervisor. */
export const decideReplyRpc = defineRpc({
  name: "board.decide-reply",
  input: z.object({
    id: z.string(),
    choice: z.string(),
    text: z.string(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Change a letter already picked, within 24 hours: opens a copy closed with the new letter and tells the <leader>. */
export const changeDecisionRpc = defineRpc({
  name: "board.change-decision",
  input: z.object({ id: z.string(), choice: z.string(), text: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string(), newId: z.string().nullable() }),
});

export const leaderReplyRpc = defineRpc({
  name: "board.leader-reply",
  input: z.object({ project: z.string().trim().min(1).max(200), text: z.string().max(LEADER_REPLY_LIMIT).refine((s) => s.trim().length > 0, { error: () => t("board.leaderReply.empty") }) }),
  output: z.object({ ok: z.boolean(), message: z.string(), sentAt: z.string().nullable() }),
});

/** Reopen a supervisor decision the same way as `roles decide overturn`, then tell that project's supervisor. */
export const overturnDecisionRpc = defineRpc({
  name: "board.overturn-decision",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), notified: z.boolean(), message: z.string() }),
});

/** Start or continue the homepage <leader> shift. */
export const supervisorShiftRpc = defineRpc({
  name: "board.supervisor-shift",
  input: z.object({
    project: z.string(),
    action: z.enum(["start", "continue", "cancel"]),
  }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    job: shiftProgressSchema,
  }),
});

/** Run the three plugins' compat scripts now, even if Paseo has not been upgraded. */
export const compatCheckRpc = defineRpc({
  name: "board.compat-check",
  input: z.object({}),
  output: z.object({ started: z.boolean(), message: z.string() }),
});

export type BoardSnapshot = z.infer<typeof boardSnapshotRpc.output>;
export type BoardInsights = z.infer<typeof boardInsightsRpc.output>;
export type BoardAgent = z.infer<typeof agentSchema>;
export type BoardPr = z.infer<typeof prSchema>;
export type BoardModel = z.infer<typeof modelSchema>;
