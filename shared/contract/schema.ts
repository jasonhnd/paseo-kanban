// fleet-quota/v1: the file contract between Agent Fleet Cockpit and Paseo Kanban.
// Each plugin writes its own `exports/` directory; the other plugin only reads it.
// Versioning: within v1 fields are only added, never removed or redefined. A breaking change
// starts `fleet-quota/v2` with `.v2` file names, and producers write both for one release.
import { z } from "zod";

export const CONTRACT_SCHEMA = "fleet-quota/v1";
export const CONTRACT_VERSION = "1.3.0";

export const PLUGIN_IDS = {
  cockpit: "agent-fleet-cockpit",
  kanban: "paseo-kanban",
} as const;

export type PluginId = (typeof PLUGIN_IDS)[keyof typeof PLUGIN_IDS];

const isoDateTime = z.iso.datetime({ offset: true });

export const Envelope = z.object({
  schema: z.literal(CONTRACT_SCHEMA),
  producer: z.enum([PLUGIN_IDS.cockpit, PLUGIN_IDS.kanban]),
  producerVersion: z.string(),
  /** Optional for v1.0 readers and files; additive contract revisions use semantic versions. */
  contractVersion: z.string().optional(),
  generatedAt: isoDateTime,
  ttlSeconds: z.number().int().positive(),
});

const byCockpit = { producer: z.literal(PLUGIN_IDS.cockpit) };
const byKanban = { producer: z.literal(PLUGIN_IDS.kanban) };

// cockpit.json / kanban.json: whether the other plugin is installed and how to reach it.
const infoFields = {
  dataDir: z.string(),
  cli: z.string().nullable(),
  features: z.array(z.string()),
};

export const CockpitInfo = Envelope.extend({ ...byCockpit, ...infoFields });
export const KanbanInfo = Envelope.extend({ ...byKanban, ...infoFields });

export const PoolState = z.object({
  adapter: z.string().optional(),
  providers: z.array(z.string()).optional(),
  parent: z.string().nullable().optional(),
  reservePct: z.number().min(0).max(100).optional(),
  projectedPct: z.number().nonnegative().nullable().optional(),
  runsOutAt: isoDateTime.nullable().optional(),
  burnRatePctPerHour: z.number().nonnegative().nullable().optional(),
  forecastConfidence: z.enum(["high", "low", "none"]).optional(),
  state: z.enum(["known", "unknown"]).optional(),
  quotaStateExpiresAt: isoDateTime.nullable().optional(),
  unknownQuota: z.object({ maxAgeMs: z.number().positive(), maxConcurrent: z.number().int().nonnegative(), tiers: z.array(z.enum(["L1", "L2", "L3", "L4"])) }).optional(),
  quotaProtection: z.enum(["pause", "none"]).optional(),
  readingExpiresAt: isoDateTime.nullable().optional(),
  dispatchable: z.boolean(),
  deprioritize: z.boolean(),
  prefer: z.boolean(),
  usedPct: z.number().min(0).max(100).nullable(),
  resetsAt: isoDateTime.nullable(),
  onlyRoles: z.array(z.string()).nullable(),
  reason: z.string().nullable(),
});

export const PoolStatus = Envelope.extend({
  quotaConfigured: z.boolean().optional(),
  ...byCockpit,
  pools: z.record(z.string(), PoolState),
  priority: z
    .object({
      order: z.array(z.string()),
      mode: z.enum(["user", "auto"]),
    })
    .nullable(),
});

export const MatrixEntry = z.object({
  profile: z.string(),
  effort: z.string().nullable(),
  paused: z.boolean().optional(),
  /** Explicit candidate order, ahead of quota-sorted candidates without this field. */
  order: z.number().int().min(1).max(1000).optional(),
});

/** Tier name (L1..L4) to an ordered candidate list. */
export const TierMap = z.record(z.string(), z.array(MatrixEntry));

/** Exact actual model ids. A present model branch must never be stripped by a legacy union alternative. */
export const ModelRoleMatrix = z.object({ byExecutorModel: z.record(z.string().trim().min(1), TierMap) }).passthrough();
const LegacyFamilyRoleMatrix = z.object({ byExecutorFamily: z.record(z.string(), TierMap) }).passthrough()
  .refine(value => !Object.hasOwn(value, "byExecutorModel"), "Invalid model branch");
const DirectRoleMatrix = TierMap.refine(value => !Object.hasOwn(value, "byExecutorModel") && !Object.hasOwn(value, "byExecutorFamily"), "Reserved branch key");
/** Producers emit model branches; family branches remain readable only for legacy candidate migration. */
export const RoleMatrix = z.union([ModelRoleMatrix, LegacyFamilyRoleMatrix, DirectRoleMatrix]);

// dispatch-matrix.json keeps the existing version/defaultTier/roles shape inside the envelope.
export const DispatchMatrix = Envelope.extend({
  ...byCockpit,
  version: z.number().int(),
  defaultTier: z.string(),
  roles: z.record(z.string(), RoleMatrix),
  downgradeWhenTight: z.array(z.string()),
  priority: z
    .object({
      order: z.array(z.string()),
      until: isoDateTime,
      mode: z.enum(["quota", "manual"]).optional(),
    })
    .nullable()
    .optional(),
});

export const OpenDecision = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  detail: z.string(),
  blocking: z.boolean(),
  agentId: z.string().nullable(),
  createdAt: isoDateTime,
  owner: z.string().nullable().optional(),
  userComments: z.array(z.object({ at: isoDateTime, note: z.string() })).optional(),
});

export const Decision = OpenDecision.extend({ status: z.string().min(1) });
export const Decisions = Envelope.extend({ ...byCockpit, items: z.array(Decision) });
export const PausedProjects = Envelope.extend({
  ...byCockpit,
  projects: z.array(z.object({ project: z.string().min(1), since: isoDateTime.nullable(), note: z.string() })),
});

export const DecisionsOpen = Envelope.extend({ ...byCockpit, items: z.array(OpenDecision) });

export const BoardProject = z.object({
  name: z.string(),
  code: z.string(),
  leaderAgentId: z.string().nullable(),
  root: z.string().nullable(),
});

export const BoardCard = z.object({
  code: z.string(),
  project: z.string(),
  status: z.string(),
  role: z.string(),
  agentId: z.string().nullable(),
  pool: z.string().nullable(),
  profile: z.string().nullable(),
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
});

// board-summary.json: open cards plus cards finished in the last 24 hours.
export const BoardSummary = Envelope.extend({
  ...byKanban,
  projects: z.array(BoardProject),
  cards: z.array(BoardCard),
  /** Optional: the board database, which the cockpit may open read-only for deeper queries. */
  dbPath: z.string().nullable(),
});

export type Envelope = z.infer<typeof Envelope>;
export type CockpitInfo = z.infer<typeof CockpitInfo>;
export type KanbanInfo = z.infer<typeof KanbanInfo>;
export type PoolState = z.infer<typeof PoolState>;
export type PoolStatus = z.infer<typeof PoolStatus>;
export type MatrixEntry = z.infer<typeof MatrixEntry>;
export type DispatchMatrix = z.infer<typeof DispatchMatrix>;
export type OpenDecision = z.infer<typeof OpenDecision>;
export type Decision = z.infer<typeof Decision>;
export type Decisions = z.infer<typeof Decisions>;
export type PausedProjects = z.infer<typeof PausedProjects>;
export type DecisionsOpen = z.infer<typeof DecisionsOpen>;
export type BoardProject = z.infer<typeof BoardProject>;
export type BoardCard = z.infer<typeof BoardCard>;
export type BoardSummary = z.infer<typeof BoardSummary>;

/** Every export file: who writes it, its file name, the default TTL, and its payload schema. */
export const EXPORTS = {
  cockpit: { producer: PLUGIN_IDS.cockpit, file: "cockpit.json", ttlSeconds: 1800, schema: CockpitInfo },
  poolStatus: { producer: PLUGIN_IDS.cockpit, file: "pool-status.json", ttlSeconds: 900, schema: PoolStatus },
  dispatchMatrix: {
    producer: PLUGIN_IDS.cockpit,
    file: "dispatch-matrix.json",
    ttlSeconds: 900,
    schema: DispatchMatrix,
  },
  decisionsOpen: { producer: PLUGIN_IDS.cockpit, file: "decisions-open.json", ttlSeconds: 600, schema: DecisionsOpen },
  decisions: { producer: PLUGIN_IDS.cockpit, file: "decisions.json", ttlSeconds: 600, schema: Decisions },
  pausedProjects: { producer: PLUGIN_IDS.cockpit, file: "paused-projects.json", ttlSeconds: 600, schema: PausedProjects },
  kanban: { producer: PLUGIN_IDS.kanban, file: "kanban.json", ttlSeconds: 1800, schema: KanbanInfo },
  boardSummary: { producer: PLUGIN_IDS.kanban, file: "board-summary.json", ttlSeconds: 900, schema: BoardSummary },
} as const;

export type ExportKind = keyof typeof EXPORTS;

export type ExportPayload<K extends ExportKind> = z.infer<(typeof EXPORTS)[K]["schema"]>;
