/// <reference types="node" />
import { zhCN, zhCNPart } from "./locale";
import type { DecisionView } from "../../shared/decisions";

/** A card as the board RPC sends it. Tests override only what they care about. */
export function boardCard(over: Record<string, unknown> = {}) {
  return {
    id: 17, code: "XYZ_0017", project: "demo_tasks", title: "Release", role: "executor", roleLabel: zhCN("labels.role.executor"), status: "running",
    profile: null, model: null, agentId: null, reviewRound: 0, blockedAt: null, blockedKind: null, blockedReason: null,
    startedAt: null, currentText: null, executorText: null, executorAgentId: null, nextStep: null, cleanupNote: null,
    tempNote: null, contract: "local-only", prUrl: null, unattended: false, mcpNote: null, stallNote: null,
    finishedAt: null, awaitingMerge: false, column: "doing", badge: zhCN("labels.status.running"), assigner: zhCN("labels.assigner.user"), assignerShort: zhCN("labels.assigner.user"), modelShort: "Claude Sonnet 5.5",
    related: ("demo_tasks · " + zhCNPart("boardView.drag", 0, 3) + "0 " + zhCNPart("missingCwd.purge.notThisCard", 4, 5)), assignee: ((zhCN("labels.role.executor") + " ") + "· Opus"), goal: "Implement feature GOAL-LONG-TEXT",
    acceptance: "Tests pass ACCEPT-LONG-TEXT", acceptanceMissing: false, returnNote: null, outcome: null, tier: "L2", tierLabel: "L2",
    leaderUnresponsive: false, leaderHold: false, workBytes: null, ...over,
  };
}

export function boardSnapshot(tasks: Array<ReturnType<typeof boardCard>>, decisions: DecisionView[] = [], over: Record<string, unknown> = {}) {
  return {
    projects: ["demo_tasks"], tasks, archivedCount: 0, attention: 0, pool: { state: "fresh", message: zhCNPart("pools.freshMessage", 4, 6) },
    autoStart: null, concurrency: { global: 2, pools: {}, roles: {} }, supervisorAgentId: null, projectSupervisorId: null,
    supervisorHeadline: zhCN("server.leader.perProject"), supervisorPrompt: null, unattended: 0, schedulerReady: true, schedulerIdle: null,
    matrixMessage: null, missingCwdMessage: null, tempWorkspaceMessage: null, restartMessage: null, doctorReds: [],
    decisions: { items: decisions, message: null }, leaders: { demo_tasks: { agentId: "project-leader", reason: null } },
    projectRows: [{ project: "demo_tasks", running: 1, acceptance: 0, blocked: 0, waiting: 0, done: 0, leaderAgentId: "project-leader", leaderTitle: "<leader> · demo_tasks", lastLeaderActionAt: "2026-10-02T00:00:00Z" }],
    ...over,
  };
}

export function taskDetail(card: ReturnType<typeof boardCard>, over: Record<string, unknown> = {}) {
  return {
    task: { ...card, brief: "BRIEF-FULL-TEXT Goal: release", workspacePath: "/tmp/x", workspaceKind: "dir", workspaceBase: null, branch: null, lane: null,
      paseoWorkspace: null, profileOverride: null, tags: [], effort: null, executorProfile: null, executorFamily: null,
      executorAgentId: null, handoff: JSON.stringify({ summary: "Completion summary HANDOFF-SUM", handoff: { verification: "Tests pass", risks: "None", files: "a.ts" } }),
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
    parents: [], children: [], comments: [], events: [], runs: [],
    review: { kind: "approve", at: "2026-10-02T01:00:00Z", actor: "reviewer", summary: "REVIEW-OK Sample text" },
    reviewHold: null, holdRounds: [], pr: null, ...over,
  };
}
