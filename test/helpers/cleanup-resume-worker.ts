/// <reference types="node" />
// Fresh isolated process: only synthetic API operations, real tmp DB/fs/Git.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupFinished } from "../../server/archive-book";
import { invalidateAgentIndex } from "../../server/agent-index";
import { setWakeSender } from "../../server/bus";
import { drainCleanups, installCleanup } from "../../server/cleanup";
import { closeDb, getDb } from "../../server/db";
import { setMissingCwdHooks, resetMissingCwdForTests } from "../../server/missing-cwd";
import { getTask } from "../../server/store";
import { readWorktreeCreated } from "../../server/worktree-record";
import type { ListedWorkspace } from "../../server/placement";

const id = Number(process.argv[2]);
const task = getTask(id);
const archived: string[] = [];
const inventory = new Map<string, ListedWorkspace>();
for (const row of getDb().prepare("SELECT id FROM tasks").all() as Array<{ id: number }>) {
  const card = getTask(row.id), record = readWorktreeCreated(row.id);
  if (card.paseo_workspace_id && record?.directory && record.root) inventory.set(card.paseo_workspace_id, {
    id: card.paseo_workspace_id, directory: record.directory, projectRoot: record.root, projectId: null,
    name: "copy", kind: "worktree", archived: cleanupFinished(row.id),
  });
}
setWakeSender(() => {});
const remove = async (agent: string) => { rmSync(join(process.env.KANBAN_AGENTS_DIR!, "bucket", `${agent}.json`), { force: true }); invalidateAgentIndex(); };
setMissingCwdHooks({ deleteAgent: remove, ...(process.argv[4] === "agents" ? {
  listAgents: () => { throw new Error("synthetic unreadable agent inventory"); },
} : {}) });
installCleanup({
  archiveAgent: remove, archiveWorkspace: async workspace => { archived.push(workspace); inventory.get(workspace)!.archived = true; },
  listAgents: async () => [], listWorkspaceIds: async () => new Set(inventory.keys()),
  inspectAgent: async agent => existsSync(join(process.env.KANBAN_AGENTS_DIR!, "bucket", `${agent}.json`)) ? { archived: false, busy: false } : null,
  inspectWorkspace: async workspace => {
    if (process.argv[4] === "true" && workspace === task.paseo_workspace_id) throw new Error("synthetic unknown workspace read");
    return inventory.get(workspace) ?? null;
  },
}, { timeoutMs: 2000 });
await drainCleanups(process.argv[3] ? new Date(process.argv[3]) : new Date());
console.log(JSON.stringify({ finished: cleanupFinished(id), archived: archived.filter(workspace => workspace === task.paseo_workspace_id) }));
installCleanup(null); resetMissingCwdForTests(); closeDb();
