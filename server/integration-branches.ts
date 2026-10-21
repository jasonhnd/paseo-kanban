/// <reference types="node" />
import { t } from "../shared/i18n";
import type { GitRunner } from "./git";

function matchesIntegrationRef(ref: string, name: string): boolean {
  if (name.startsWith("refs/")) return ref === name;
  if (ref === `refs/heads/${name}` || ref === `refs/remotes/${name}`) return true;
  if (!ref.startsWith("refs/remotes/")) return false;
  const remoteBranch = ref.slice("refs/remotes/".length);
  return remoteBranch.slice(remoteBranch.indexOf("/") + 1) === name;
}

/**
 * Read only existing local/remote-tracking branch refs, never tags or the network.
 * Cleanup and doctor use the same ancestry proof. No configuration means no Git reads.
 */
export async function integrationBranchContaining(
  root: string,
  branch: string,
  names: readonly string[],
  run: GitRunner,
): Promise<{ ref: string } | { error: string } | null> {
  if (names.length === 0) return null;
  const refs = await run(root, ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"]);
  if (refs.code !== 0) return { error: (refs.stderr || refs.stdout || t("worktreeGc.gitFailed", { command: "git for-each-ref" })).trim() };
  for (const ref of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    // Deleting the only ref to the card tip would not preserve its work anywhere.
    if (ref === `refs/heads/${branch}`) continue;
    if (!names.some(name => matchesIntegrationRef(ref, name))) continue;
    const contained = await run(root, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, ref]);
    if (contained.code === 0) return { ref };
    if (contained.code !== 1) return { error: (contained.stderr || contained.stdout || t("worktreeGc.gitFailed", { command: "git merge-base" })).trim() };
  }
  return null;
}
