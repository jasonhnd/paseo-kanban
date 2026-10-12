import { getDb } from "./db";
import { dependencyMet } from "./deps";
import { cachedMergeState, readContract } from "./pr";

type NodeState = { status: string; contract: string | null };

function stillBlocks(node: NodeState): boolean {
  if (!dependencyMet(node.status)) return true;
  const contract = readContract(node.contract);
  return contract.kind === "github" && !(contract.pr && cachedMergeState(contract.pr)?.merged);
}

/** One graph read per tick/board response; shared descendant sets deduplicate diamonds. */
export function downstreamCounts(): Map<number, number> {
  const rows = getDb().prepare(`
    SELECT l.parent_id, l.task_id, p.status AS parent_status, p.contract_json AS parent_contract,
           c.status AS child_status, c.contract_json AS child_contract
    FROM links l JOIN tasks p ON p.id = l.parent_id JOIN tasks c ON c.id = l.task_id
  `).all() as unknown as Array<{
    parent_id: number; task_id: number; parent_status: string; parent_contract: string | null;
    child_status: string; child_contract: string | null;
  }>;
  const children = new Map<number, Set<number>>();
  const parents = new Map<number, Set<number>>();
  for (const row of rows) {
    // An unreadable contract on one link must not blank the ordering for every other card.
    try {
      if (!stillBlocks({ status: row.parent_status, contract: row.parent_contract }) ||
          !stillBlocks({ status: row.child_status, contract: row.child_contract })) continue;
    } catch {
      continue;
    }
    if (!children.has(row.parent_id)) children.set(row.parent_id, new Set());
    if (!children.has(row.task_id)) children.set(row.task_id, new Set());
    if (!parents.has(row.task_id)) parents.set(row.task_id, new Set());
    children.get(row.parent_id)!.add(row.task_id);
    parents.get(row.task_id)!.add(row.parent_id);
  }
  const remaining = new Map([...children].map(([id, set]) => [id, set.size]));
  const descendants = new Map<number, Set<number>>();
  const queue = [...remaining].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    const below = descendants.get(id) ?? new Set<number>();
    descendants.set(id, below);
    for (const parent of parents.get(id) ?? []) {
      const set = descendants.get(parent) ?? new Set<number>();
      set.add(id);
      for (const child of below) set.add(child);
      descendants.set(parent, set);
      const left = remaining.get(parent)! - 1;
      remaining.set(parent, left);
      if (left === 0) queue.push(parent);
    }
  }
  // Links are validated as a DAG. Bound traversal even for a corrupt/imported cycle.
  for (const [id, left] of remaining) {
    if (left === 0) continue;
    const seen = new Set<number>([id]);
    const stack = [...children.get(id)!];
    while (stack.length) {
      const child = stack.pop()!;
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(...(children.get(child) ?? []));
    }
    seen.delete(id);
    descendants.set(id, seen);
  }
  return new Map([...descendants].map(([id, set]) => [id, set.size]));
}

/** Preserve the existing status buckets and explicit priority; ties retain input order. */
export function orderByDownstream<T extends { id: number; priority: number }>(rows: T[], counts: ReadonlyMap<number, number>): T[] {
  return [...rows].sort((a, b) => b.priority - a.priority || (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
}
