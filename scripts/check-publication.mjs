#!/usr/bin/env node
// pre-push stdin is the complete proposed ref set. Scan full reachable histories and verify each target.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run as scan, loadRules, loadDenylist, defaultListPath, scanFile, summarizeHistoryFindings } from "./check-private.mjs";
import { run as identity, judge, parseIdent } from "./check-identity.mjs";
import { historyObjects, objectId, git } from "./git-objects.mjs";
import { verifyRef } from "./verify-ref.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ZERO = /^0{40,64}$/;
const SHA = /^[0-9a-f]{40,64}$/;

export function proposedRefs(input) {
  return input.trim().split("\n").filter(Boolean).map(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !SHA.test(fields[1]) || !SHA.test(fields[3])) throw new Error("malformed pre-push ref input");
    return { localRef: fields[0], tip: fields[1], remoteRef: fields[2], remoteTip: fields[3] };
  }).filter(item => !ZERO.test(item.tip));
}

export function checkPublication(input, { root = ROOT, env = process.env, log = console.log } = {}) {
  const proposed = proposedRefs(input);
  // A manual invocation still scans and verifies the exact current commit; deletions send no source content.
  const refs = proposed.length || input.trim() ? proposed : [{ tip: objectId(root, "HEAD") }];
  const privateRules = loadDenylist(defaultListPath(env));
  const compiled = loadRules();
  let status = 0;
  if (git(root, ["status", "--porcelain"]).trim()) { log("publication: working checkout is not clean"); status = 1; }
  const verified = new Set();
  for (const ref of refs) {
    for (const name of [ref.localRef, ref.remoteRef].filter(Boolean)) {
      const hits = scanFile("ref-name.txt", name, compiled, privateRules);
      if (hits.length) { log(`publication: refused ref name (${hits.length} redacted privacy finding(s))`); status = 1; }
    }
    const history = scan(["--history", ref.tip, "--quiet", "--list", defaultListPath(env)], env, root);
    log(`publication: ${JSON.stringify(history.scope)}; ${history.hits.length} privacy finding(s)`);
    for (const hit of summarizeHistoryFindings(history.hits)) log(`publication: refused ${hit.path}:${hit.rule} (${hit.count})`);
    if (history.hits.length) status = 1;
    const identities = identity(["--range", history.scope.commit, "--list", defaultListPath(env)], env, root);
    if (identities.problems.length) {
      const groups = new Map();
      for (const problem of identities.problems) {
        const type = problem.replace(/^[0-9a-f]{12} (author|committer): /, "$1: ");
        groups.set(type, (groups.get(type) ?? 0) + 1);
      }
      for (const [type, count] of groups) log(`publication: ${type} (${count})`);
      status = 1;
    }
    const objects = historyObjects(root, ref.tip);
    let refusedTagIdentities = 0;
    for (const tag of objects.tags.values()) {
      const tagger = /^tagger (.+)$/m.exec(tag.data.toString("utf8"));
      if (!tagger || judge({ where: "tag identity", ...parseIdent(tagger[1]) }, privateRules).length) refusedTagIdentities += 1;
    }
    if (refusedTagIdentities) { log(`publication: refused tag identity (${refusedTagIdentities})`); status = 1; }
    const secret = spawnSync("gitleaks", ["git", `--log-opts=${history.scope.commit}`, "--redact", "--no-banner", root], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
    if (secret.error || secret.status !== 0) { log("publication: secret scan failed or gitleaks is unavailable"); status = 1; }
    // gitleaks' Git scan does not inspect annotated-tag messages. Scan their raw object bytes separately.
    for (const tag of objects.tags.values()) {
      const result = spawnSync("gitleaks", ["stdin", "--redact", "--no-banner"], { cwd: root, env, input: tag.data, stdio: ["pipe", "inherit", "inherit"] });
      if (result.error || result.status !== 0) { log("publication: tag secret scan failed"); status = 1; }
    }
    if (!verified.has(history.scope.commit)) {
      verified.add(history.scope.commit);
      if (verifyRef(history.scope.commit, { root, sourceEnv: env }) !== 0) status = 1;
    }
  }
  log(status === 0 ? "publication: all proposed refs passed" : "pre-push: refused; nothing was pushed");
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = checkPublication(readFileSync(0, "utf8")); }
  catch (error) { console.error(`publication: setup failure: ${error.message}`); process.exitCode = 2; }
}
