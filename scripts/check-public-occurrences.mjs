#!/usr/bin/env node
// Every reviewed public-name collision must still exist in the exact working tree or in
// history reachable from HEAD. The reachable-history privacy gate needs the approval of
// every committed occurrence, so a line edited after commit keeps its old approval; an
// approval that matches nothing in either place is stale.
// Use the declared public literals for freshness, independent of a local denylist.
// Actual privacy gates still load and enforce the entire private denylist.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { loadRules, parseDenylist, scanFile, unusedPublicOccurrences } from "./check-private.mjs";
import { historyObjects } from "./git-objects.mjs";
const compiled = loadRules();
const literals = parseDenylist(compiled.publicOccurrenceLiterals.join("\n"));
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {encoding: "utf8"}).split("\0").filter(Boolean);
for (const path of new Set(files)) {
  if (!existsSync(path)) continue;
  const data = readFileSync(path);
  scanFile(path, data.includes(0) ? null : data.toString("utf8"), compiled, literals);
}
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {encoding: "utf8"}).trim();
if (spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {cwd: root}).status === 0) {
  // Same objects and paths as `check-private.mjs --history HEAD`.
  const objects = historyObjects(root, "HEAD");
  for (const entry of objects.files) {
    const data = objects.blobs.get(entry.id).data;
    scanFile(entry.path, data.includes(0) ? null : data.toString("utf8"), compiled, literals);
  }
  for (const [id, object] of [...objects.commits, ...objects.tags]) {
    scanFile(`${object.type}-object/${id}`, object.data.toString("utf8"), compiled, literals);
  }
}
const unused = unusedPublicOccurrences(compiled).length;
console.log(`public occurrences: ${unused} stale approval(s)`);
process.exitCode = unused > 0 ? 1 : 0;
