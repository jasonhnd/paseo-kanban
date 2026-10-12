import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function git(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"], ...options,
  });
}

export function objectId(root, rev, peel = "object") {
  const id = git(root, ["rev-parse", "--verify", `${rev}^{${peel}}`]).trim();
  if (!/^[0-9a-f]{40,64}$/.test(id)) throw new Error("invalid Git object id");
  return id;
}

/** Read each immutable object once; never enumerate unrelated refs or copy a repository. */
export function readObjects(root, ids) {
  const objects = new Map();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += 128) {
    const batch = unique.slice(start, start + 128);
    const out = git(root, ["cat-file", "--batch"], { encoding: null, input: Buffer.from(batch.join("\n") + "\n") });
    let offset = 0;
    for (const expected of batch) {
      const end = out.indexOf(10, offset);
      const header = out.subarray(offset, end).toString("utf8");
      const match = /^([0-9a-f]+) (blob|tree|commit|tag) (\d+)$/.exec(header);
      if (!match || match[1] !== expected) throw new Error(`cannot read Git object ${expected}`);
      const size = Number(match[3]);
      const data = out.subarray(end + 1, end + 1 + size);
      if (data.length !== size || out[end + 1 + size] !== 10) throw new Error("truncated Git object stream");
      objects.set(expected, { type: match[2], data });
      offset = end + 2 + size;
    }
    if (offset !== out.length) throw new Error("unexpected Git object stream");
  }
  return objects;
}

export function treeEntries(root, rev) {
  return git(root, ["ls-tree", "-r", "-z", "--full-tree", rev]).split("\0").filter(Boolean).map(row => {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error("invalid Git tree entry");
    return { mode: match[1], type: match[2], id: match[3], path: match[4] };
  });
}

export function historyObjects(root, rev) {
  const tip = objectId(root, rev);
  const tags = new Map();
  let peeled = tip;
  for (;;) {
    const object = readObjects(root, [peeled]).get(peeled);
    if (object.type !== "tag") {
      if (object.type !== "commit") throw new Error("publication refs must point to commits or commit tags");
      break;
    }
    tags.set(peeled, object);
    const target = /^object ([0-9a-f]{40,64})$/m.exec(object.data.toString("utf8"));
    if (!target || tags.has(target[1])) throw new Error("invalid tag target");
    peeled = target[1];
  }
  const rows = git(root, ["rev-list", "--format=%H %T", "--no-commit-header", peeled]).trim().split("\n");
  const commits = readObjects(root, rows.map(row => row.split(" ")[0]));
  const trees = [...new Set(rows.map(row => row.split(" ")[1]))];
  const files = new Map();
  for (const tree of trees) for (const entry of treeEntries(root, tree)) {
    if (entry.type !== "blob") throw new Error(`unsupported non-blob tree entry: ${entry.path}`);
    files.set(`${entry.path}\0${entry.id}`, entry);
  }
  const blobs = readObjects(root, [...files.values()].map(entry => entry.id));
  return { tip, commit: peeled, commits, tags, trees, files: [...files.values()], blobs };
}

/** Export only one approved tree into an empty disposable directory; no private Git ancestry. */
export function exportCommit(root, rev, destination) {
  const commit = objectId(root, rev, "commit");
  const entries = treeEntries(root, commit);
  const blobs = readObjects(root, entries.map(entry => entry.id));
  for (const entry of entries) {
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)
        || entry.path.split("/").some(part => part === ".." || part === ".git") || entry.path.startsWith("/")) {
      throw new Error(`cannot export unsafe or unsupported entry: ${entry.path}`);
    }
    const target = join(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, blobs.get(entry.id).data);
    chmodSync(target, entry.mode === "100755" ? 0o755 : 0o644);
  }
  return { commit, files: entries.length };
}
