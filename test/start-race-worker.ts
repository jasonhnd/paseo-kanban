/// <reference types="node" />
import { zhCN } from "./helpers/locale";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const raw = process.argv[2];
if (!raw) {
  console.error("missing worker payload");
  process.exit(1);
}
const data = JSON.parse(raw) as {
  dataDir: string;
  taskId: number;
  name: string;
  releaseFile: string;
};

process.env.KANBAN_DATA_DIR = data.dataDir;
process.env.KANBAN_AGENTS_DIR = join(data.dataDir, "agents");
process.env.KANBAN_WORKTREES_ROOT = join(data.dataDir, "worktrees");

const { existsSync } = await import("node:fs");
// A separate process: pick the language the way the command line does (KANBAN_LANGUAGE first).
const { applyServerLanguage } = await import("../server/language");
applyServerLanguage();
const { startTask } = await import("../server/dispatch");

const executor = {
  id: "ex",
  name: zhCN("labels.role.executor"),
  role: "executor",
  family: "xai",
  provider: "cursor",
  model: "grok-4.7",
  pool: "cursor",
};

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function waitForRelease(): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!existsSync(data.releaseFile)) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

try {
  const result = await startTask(
    data.taskId,
    {
      async create(options) {
        send({ type: "agent", name: data.name, cwd: options.cwd, workspaceId: options.workspaceId ?? null });
        return { id: `agent-${data.name}`, workspaceId: options.workspaceId };
      },
      async send() {},
      async createWorktree(options) {
        const directory = join(data.dataDir, "trees", data.name);
        mkdirSync(directory, { recursive: true });
        send({ type: "worktree", name: data.name, directory, branch: options.branchName });
        await waitForRelease();
        return { directory, workspaceId: `ws-${data.name}`, name: options.title ?? data.name };
      },
      async archiveWorkspace(workspaceId) {
        send({ type: "archive", name: data.name, workspaceId });
      },
      async listAgents() {
        return [];
      },
    },
    data.name,
    { profiles: [executor], chosen: executor, reason: "Test" },
  );
  send({ type: "done", name: data.name, result });
} catch (err) {
  send({
    type: "done",
    name: data.name,
    error: err instanceof Error ? err.message : String(err),
  });
}
