// Demo payloads for contract tests. Every value is made up; nothing refers to a real project or agent.
import { CONTRACT_SCHEMA, PLUGIN_IDS, type ExportKind, type ExportPayload } from "../../../shared/contract/schema";

export const NOW = new Date("2030-01-01T00:00:00.000Z");
export const DEMO_AGENT = "00000000-0000-4000-8000-000000000001";

const cockpitEnvelope = {
  schema: CONTRACT_SCHEMA,
  producer: PLUGIN_IDS.cockpit,
  producerVersion: "0.0.0-demo",
  generatedAt: NOW.toISOString(),
} as const;

const kanbanEnvelope = { ...cockpitEnvelope, producer: PLUGIN_IDS.kanban } as const;

export const VALID: { [K in ExportKind]: ExportPayload<K> } = {
  cockpit: {
    ...cockpitEnvelope,
    ttlSeconds: 1800,
    dataDir: "/tmp/demo/plugin-data/agent-fleet-cockpit",
    cli: "/tmp/demo/bin/afc",
    features: ["decisions", "quota"],
  },
  poolStatus: {
    ...cockpitEnvelope,
    ttlSeconds: 900,
    pools: {
      "demo-pool-a": {
        dispatchable: true,
        deprioritize: false,
        prefer: true,
        usedPct: 42.5,
        resetsAt: "2030-01-07T00:00:00.000Z",
        onlyRoles: null,
        reason: null,
      },
      "demo-pool-b": {
        dispatchable: false,
        deprioritize: true,
        prefer: false,
        usedPct: null,
        resetsAt: null,
        onlyRoles: ["reviewer"],
        reason: "ahead of pace",
      },
    },
    priority: { order: ["demo-pool-a", "demo-pool-b"], mode: "user" },
  },
  dispatchMatrix: {
    ...cockpitEnvelope,
    ttlSeconds: 900,
    version: 1,
    defaultTier: "L2",
    roles: {
      executor: {
        L1: [{ profile: "Demo executor", effort: "low" }],
        L2: [
          { profile: "Demo executor", effort: "medium" },
          { profile: "Demo helper", effort: null, paused: true },
        ],
      },
      reviewer: {
        byExecutorFamily: {
          "demo-family": { L2: [{ profile: "Demo reviewer", effort: "high" }] },
        },
      },
    },
    downgradeWhenTight: ["L1", "L2"],
    priority: { order: ["demo-pool-a"], until: "2030-01-01T00:30:00.000Z", mode: "quota" },
  },
  decisionsOpen: {
    ...cockpitEnvelope,
    ttlSeconds: 600,
    items: [
      {
        id: "d0101-000000-1",
        project: "DEMO",
        title: "Pick a demo option",
        detail: "A: one. B: two. Recommended: A.",
        blocking: false,
        agentId: DEMO_AGENT,
        createdAt: "2029-12-31T12:00:00.000Z",
      },
    ],
  },
  decisions: {
    ...cockpitEnvelope,
    ttlSeconds: 600,
    items: [{ id: "d0101-000000-1", project: "DEMO", title: "Pick a demo option", detail: "A or B", blocking: false, agentId: DEMO_AGENT, createdAt: "2029-12-31T12:00:00.000Z", status: "done" }],
  },
  pausedProjects: { ...cockpitEnvelope, ttlSeconds: 600, projects: [{ project: "demo", since: NOW.toISOString(), note: "On hold" }] },
  kanban: {
    ...kanbanEnvelope,
    ttlSeconds: 1800,
    dataDir: "/tmp/demo/plugin-data/paseo-kanban",
    cli: null,
    features: [],
  },
  boardSummary: {
    ...kanbanEnvelope,
    ttlSeconds: 900,
    projects: [{ name: "demo-project", code: "DEMO", leaderAgentId: DEMO_AGENT, root: null }],
    cards: [
      {
        code: "DEMO_0001",
        project: "demo-project",
        status: "running",
        role: "executor",
        agentId: DEMO_AGENT,
        pool: "demo-pool-a",
        profile: "Demo executor",
        startedAt: "2029-12-31T23:00:00.000Z",
        finishedAt: null,
      },
    ],
    dbPath: null,
  },
};

/** One broken variant per kind, each failing for a payload-specific reason. */
export const INVALID: { [K in ExportKind]: { label: string; value: unknown } } = {
  cockpit: { label: "features is not an array", value: { ...VALID.cockpit, features: "quota" } },
  poolStatus: {
    label: "usedPct above 100",
    value: {
      ...VALID.poolStatus,
      pools: { "demo-pool-a": { ...VALID.poolStatus.pools["demo-pool-a"], usedPct: 101 } },
    },
  },
  dispatchMatrix: {
    label: "matrix entry without profile",
    value: { ...VALID.dispatchMatrix, roles: { executor: { L1: [{ effort: "low" }] } } },
  },
  decisionsOpen: {
    label: "createdAt is not a timestamp",
    value: { ...VALID.decisionsOpen, items: [{ ...VALID.decisionsOpen.items[0], createdAt: "yesterday" }] },
  },
  decisions: { label: "missing status", value: { ...VALID.decisions, items: [VALID.decisionsOpen.items[0]] } },
  pausedProjects: { label: "empty project", value: { ...VALID.pausedProjects, projects: [{ project: "", since: null, note: "" }] } },
  kanban: { label: "written by the wrong producer", value: { ...VALID.kanban, producer: PLUGIN_IDS.cockpit } },
  boardSummary: {
    label: "card missing status",
    value: { ...VALID.boardSummary, cards: [{ ...VALID.boardSummary.cards[0], status: undefined }] },
  },
};
