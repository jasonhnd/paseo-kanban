import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const leaderStartStateSchema = z.object({
  requestId: z.string(),
  project: z.string(),
  profileId: z.string(),
  workspaceId: z.string(),
  directory: z.string(),
  language: z.enum(["en", "zh-CN"]),
  state: z.enum(["pending", "ready", "protocol-missing", "delivery-failed", "registered", "conflict"]),
  agentId: z.string().nullable(),
  version: z.string(),
  deliveryMode: z.enum(["systemPrompt", "session-message"]).nullable(),
});
export type LeaderStartState = z.infer<typeof leaderStartStateSchema>;

export const leaderOptionsRpc = defineRpc({
  name: "kanban.leader-options",
  input: z.object({ project: z.string() }),
  output: z.object({
    project: z.string(),
    version: z.string(),
    cli: z.string(),
    profiles: z.array(z.object({ id: z.string(), name: z.string(), provider: z.string(), model: z.string().nullable() })),
    workspaces: z.array(z.object({ id: z.string(), path: z.string() })),
    existingAgentId: z.string().nullable(),
    start: leaderStartStateSchema.nullable(),
  }),
});

export const leaderPreviewRpc = defineRpc({
  name: "kanban.leader-preview",
  input: z.object({ project: z.string(), profileId: z.string(), workspaceId: z.string(), language: z.enum(["en", "zh-CN"]) }),
  output: z.object({ requestId: z.string(), protocol: z.string(), directory: z.string(), version: z.string() }),
});

export const leaderStartRpc = defineRpc({
  name: "kanban.leader-start",
  input: z.object({
    project: z.string(),
    profileId: z.string(),
    workspaceId: z.string(),
    language: z.enum(["en", "zh-CN"]),
    requestId: z.string().uuid(),
  }),
  output: leaderStartStateSchema,
});

export const leaderStatusRpc = defineRpc({
  name: "kanban.leader-status",
  input: z.object({ project: z.string() }),
  output: leaderStartStateSchema.nullable(),
});

/** Explicit recovery sends a visible message. It does not claim to edit a creation-only system prompt. */
export const leaderRecoverRpc = defineRpc({
  name: "kanban.leader-recover",
  input: z.object({ project: z.string() }),
  output: leaderStartStateSchema,
});
