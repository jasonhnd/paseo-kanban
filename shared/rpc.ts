import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { decisionsSnapshotSchema, leaderTargetSchema } from "./decisions";
import { settingsDocumentSchema, settingsReadSchema, settingsWriteSchema } from "./settings";

export const cardSchema = z.object({
  id: z.number(),
  code: z.string(),
  project: z.string(),
  title: z.string(),
  role: z.string(),
  roleLabel: z.string(),
  status: z.string(),
  profile: z.string().nullable(),
  model: z.string().nullable(),
  agentId: z.string().nullable(),
  reviewRound: z.number(),
  blockedAt: z.string().nullable(),
  blockedKind: z.string().nullable(),
  blockedReason: z.string().nullable(),
  startedAt: z.string().nullable(),
  currentText: z.string().nullable(),
  executorText: z.string().nullable(),
  executorAgentId: z.string().nullable(),
  nextStep: z.string().nullable(),
  cleanupNote: z.string().nullable(),
  tempNote: z.string().nullable(),
  contract: z.string(),
  prUrl: z.string().nullable(),
  unattended: z.boolean(),
  mcpNote: z.string().nullable(),
  stallNote: z.string().nullable(),
  finishedAt: z.string().nullable(),
  awaitingMerge: z.boolean(),
  column: z.string(),
  badge: z.string(),
  assigner: z.string(),
  assignerShort: z.string().default(""),
  modelShort: z.string().default(""),
  related: z.string(),
  assignee: z.string(),
  goal: z.string(),
  acceptance: z.string(),
  acceptanceMissing: z.boolean(),
  returnNote: z.string().nullable(),
  outcome: z.string().nullable(),
  tier: z.string().nullable(),
  tierLabel: z.string(),
  leaderUnresponsive: z.boolean(),
  leaderHold: z.boolean(),
});

export const projectRowSchema = z.object({
  project: z.string(),
  running: z.number(),
  acceptance: z.number(),
  blocked: z.number(),
  waiting: z.number(),
  done: z.number(),
  leaderAgentId: z.string().nullable(),
  leaderTitle: z.string().nullable(),
  lastLeaderActionAt: z.string().nullable(),
});

export const doctorRedSchema = z.object({
  id: z.string(),
  project: z.string().nullable(),
  /** Card code when the finding is about a card; null for workspace, directory, branch and other objects. */
  card: z.string().nullable(),
  taskId: z.number().nullable(),
  object: z.string(),
  symptom: z.string(),
  suggestion: z.string(),
});

export const holdRoundSchema = z.object({
  at: z.string(),
  kind: z.string().default("request_changes"),
  reason: z.string(),
  findings: z.string(),
});

const concurrencySchema = z.object({
  global: z.number(),
  pools: z.record(z.string(), z.number()),
  roles: z.record(z.string(), z.number()),
});

const resultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});

export const boardRpc = defineRpc({
  name: "kanban.board",
  input: z.object({ project: z.string().optional() }),
  output: z.object({
    projects: z.array(z.string()),
    /** Every card except archived ones. Archived cards come from historyRpc, one page at a time. */
    tasks: z.array(cardSchema),
    archivedCount: z.number(),
    attention: z.number(),
    pool: z.object({
      state: z.enum(["fresh", "missing", "stale"]),
      message: z.string(),
    }),
    autoStart: z.boolean().nullable(),
    concurrency: concurrencySchema,
    supervisorAgentId: z.string().nullable(),
    projectSupervisorId: z.string().nullable(),
    decisions: decisionsSnapshotSchema,
    leaders: z.record(z.string(), leaderTargetSchema),
    /** One row per project for the by-project tab; unaffected by the project filter. */
    projectRows: z.array(projectRowSchema),
    supervisorHeadline: z.string(),
    supervisorPrompt: z.string().nullable(),
    unattended: z.number(),
    schedulerReady: z.boolean(),
    /** Set when the scheduler has not ticked for 3 minutes. */
    schedulerIdle: z.string().nullable(),
    /** Set when the dispatch matrix file exists but cannot be parsed. Null when it is missing or fine. */
    matrixMessage: z.string().nullable(),
    /** Set when some agent cwd is missing outside the directories Kanban may create. */
    missingCwdMessage: z.string().nullable(),
    /** Set when a temporary workspace is still open after the cleanup deadline. */
    tempWorkspaceMessage: z.string().nullable(),
    /** Set after a daemon restart; running cards from before it have been checked. */
    restartMessage: z.string().nullable(),
    /** Red findings from the last doctor report, read only. Empty when there is no report. */
    doctorReds: z.array(doctorRedSchema).default([]),
  }),
});

/** Open decisions only, re-read from decisions.json on every call. The decisions tab polls this. */
export const decisionsRpc = defineRpc({
  name: "kanban.decisions",
  input: z.object({ project: z.string().optional() }),
  output: z.object({
    decisions: decisionsSnapshotSchema,
    leaders: z.record(z.string(), leaderTargetSchema),
    /** When the server read the file. */
    readAt: z.string(),
  }),
});

/** Resolve a displayed card code (any project, archived or not) to its id. Read only; null id plus a message when no such card. */
export const resolveCardRpc = defineRpc({
  name: "kanban.resolve-card",
  input: z.object({ code: z.string() }),
  output: z.object({ id: z.number().nullable(), message: z.string().nullable() }),
});

export const historyRpc = defineRpc({
  name: "kanban.history",
  input: z.object({
    project: z.string().optional(),
    query: z.string().optional(),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(100),
  }),
  output: z.object({
    total: z.number(),
    items: z.array(
      z.object({
        id: z.number(),
        code: z.string(),
        project: z.string(),
        title: z.string(),
        archivedAt: z.string(),
        outcome: z.enum(["done", "abandoned"]),
        auto: z.boolean(),
      }),
    ),
  }),
});

export const taskDetailSchema = z.object({
  task: cardSchema.extend({
    brief: z.string(),
    workspacePath: z.string().nullable(),
    workspaceKind: z.string().nullable(),
    workspaceBase: z.string().nullable(),
    branch: z.string().nullable(),
    lane: z.string().nullable(),
    paseoWorkspace: z.string().nullable(),
    profileOverride: z.string().nullable(),
    tags: z.array(z.string()),
    effort: z.string().nullable(),
    executorProfile: z.string().nullable(),
    executorFamily: z.string().nullable(),
    executorAgentId: z.string().nullable(),
    handoff: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  parents: z.array(z.object({ id: z.number(), code: z.string(), title: z.string(), status: z.string(), project: z.string() })),
  children: z.array(z.object({ id: z.number(), code: z.string(), title: z.string(), status: z.string(), project: z.string() })),
  comments: z.array(z.object({ id: z.number(), author: z.string(), body: z.string(), createdAt: z.string() })),
  events: z.array(
    z.object({
      id: z.number(),
      at: z.string(),
      kind: z.string(),
      fromStatus: z.string().nullable(),
      toStatus: z.string().nullable(),
      actor: z.string().nullable(),
      data: z.string(),
    }),
  ),
  runs: z.array(
    z.object({
      id: z.number(),
      agentId: z.string().nullable(),
      role: z.string(),
      roleLabel: z.string(),
      profileName: z.string().nullable(),
      provider: z.string().nullable(),
      model: z.string().nullable(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      endKind: z.string().nullable(),
    }),
  ),
  review: z.object({ kind: z.string(), at: z.string(), actor: z.string().nullable(), summary: z.string() }).nullable(),
  reviewHold: z.string().nullable(),
  /** The two rejections behind the round-2 hold (review_leader_hold rounds, else the last request_changes), oldest first. Only filled while the card waits after round 2. */
  holdRounds: z.array(holdRoundSchema).default([]),
  pr: z
    .object({
      url: z.string().nullable(),
      repo: z.string().nullable(),
      awaiting: z.boolean(),
      check: z.object({ kind: z.string(), at: z.string(), summary: z.string() }).nullable(),
    })
    .nullable(),
});

export type BoardCardView = z.infer<typeof cardSchema>;
export type TaskDetailView = z.infer<typeof taskDetailSchema>;
export type DoctorRedView = z.infer<typeof doctorRedSchema>;
export type HoldRoundView = z.infer<typeof holdRoundSchema>;
export type ProjectRowView = z.infer<typeof projectRowSchema>;

export const taskRpc = defineRpc({
  name: "kanban.task",
  input: z.object({ id: z.number() }),
  output: taskDetailSchema,
});

export const archiveRpc = defineRpc({
  name: "kanban.archive",
  input: z.object({ id: z.number() }),
  output: resultSchema,
});

export const unblockRpc = defineRpc({
  name: "kanban.unblock",
  input: z.object({ id: z.number() }),
  output: resultSchema,
});

export const startRpc = defineRpc({
  name: "kanban.start",
  input: z.object({ id: z.number() }),
  output: resultSchema,
});

export const setTierRpc = defineRpc({
  name: "kanban.set-tier",
  input: z.object({ id: z.number(), tier: z.string() }),
  output: resultSchema,
});

export const openAgentRpc = defineRpc({
  name: "kanban.open-agent",
  input: z.object({ agentId: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const intakeRpc = defineRpc({
  name: "kanban.intake",
  input: z.object({ project: z.string(), text: z.string() }),
  output: resultSchema,
});

export const autoStartRpc = defineRpc({
  name: "kanban.auto-start",
  input: z.object({ project: z.string(), enabled: z.boolean() }),
  output: resultSchema,
});

export const agentsRpc = defineRpc({
  name: "kanban.agents",
  input: z.object({ project: z.string().optional() }),
  output: z.object({
    suggestedId: z.string().nullable(),
    note: z.string().nullable(),
    agents: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        archived: z.boolean(),
        closed: z.boolean(),
        createdAt: z.string().nullable(),
        role: z.string().nullable(),
      }),
    ),
  }),
});

export const supervisorRpc = defineRpc({
  name: "kanban.supervisor",
  input: z.object({ project: z.string(), agentId: z.string() }),
  output: resultSchema,
});

export const fallbackSupervisorRpc = defineRpc({
  name: "kanban.fallback-supervisor",
  input: z.object({ agentId: z.string() }),
  output: resultSchema,
});

export const agentLinkRpc = defineRpc({
  name: "kanban.agent-link",
  input: z.object({ agentId: z.string() }),
  output: z.object({ url: z.string().nullable(), message: z.string() }),
});

/** The board's configuration: the effective language, plus the settings page document and its revision. */
export const configReadRpc = defineRpc({
  name: "kanban.config.read",
  input: z.object({}),
  output: settingsReadSchema,
});

/** Replace the editable part of kanban.config.json when `revision` is still the one from config.read. */
export const configWriteRpc = defineRpc({
  name: "kanban.config.write",
  input: z.object({
    revision: z.string(),
    document: settingsDocumentSchema,
  }),
  output: settingsWriteSchema,
});
