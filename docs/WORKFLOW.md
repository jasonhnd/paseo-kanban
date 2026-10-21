# Recommended workflow

## Timed waits

When the next step is only allowed after a known wall-clock time, the assigned worker can run `block <card> --kind scheduled --until "<future ISO time with offset>" --reason "<why>"`, or call `kanban_block` with `kind: "scheduled"` and `until`. Include an explicit `Z` or `+/-HH:MM` offset. The time must be in the future, at most seven days away. Missing, invalid or past times, and `--until` on another kind, are refused without changing the card. For longer or indefinite waits, ask the lead to use `wait-user`. Do not use `transient` for timed waits. Deliverables already ready for review still complete with `handoff.waitingOn` as usual.

Board, list and detail show “Scheduled wait until <local time>”, including the timezone. The persisted deadline survives a restart. Before it, no transient retries or blocked doctor alerts occur. On the first scheduler tick at or after it, the original agent receives one resume prompt; a missing or archived agent returns to ready for normal redispatch and admission checks. Delivery failures remain pending. Database leases serialize sends, and a persisted Paseo `messageId` deduplicates retries after an interrupted acknowledgement. An interrupted lease expires after one minute. Doctor uses the existing `doctor.blockedHours.transient` grace (two hours by default), counted from the deadline, if the card has not resumed. A scoped lead may cancel the wait early with `unblock`.

This workflow is configurable. Repository instructions and the user's authorized scope take precedence. Installing a plugin does not authorize publishing, merging or spending money.

## Roles and review

| Role | Responsibility |
|---|---|
| Lead (`supervisor`) | Clarify the request, write cards, check evidence, accept work and communicate decisions. |
| Executor | Implement the brief, verify locally and commit each completed step. |
| Reviewer | Read the diff and independently check the acceptance criteria. |
| Reader | Investigate and summarize sources without implementing changes. |
| Decision | Compare technical options within the agreed scope. |
| Batch | Perform authorized operations, such as merging an approved change. |

A role is separate from its provider and model. Configure `role` and `family` on Paseo profiles; candidates also identify `candidateFor`. Configure an explicit nonempty actual model; provider and family metadata do not establish independent review. Fleet's role setup currently produces a preview for manual configuration; it does not apply profiles. Preserve existing profiles when editing the list.

Review requires two distinct, nonempty actual models after trim/lower normalization. Models in one family may review each other; one model across providers or settings may not. Missing evidence holds review. High-risk work still requires a qualified independent reviewer and lead acceptance. The default reviewer matrix lists an independent Codex `gpt-6-sol` slot at `xhigh` on L1 through L4. That slot matches model `gpt-6-sol` exactly and does not use the GPT-6.1 marker.

| Tier | Scope |
|---|---|
| L1 | Clear, small change. |
| L2 | Routine, focused implementation. |
| L3 | Several related files or an investigation. |
| L4 | Critical work: money, permissions, security, migration, external commitments or release. |

Difficulty selects configured model and effort options. It does not confer authorization or guarantee that a high-risk reviewer is configured.

## From request to finished card

1. The user configures a project, Git workspace, short code and protected branches in Kanban settings. Set up suitable profiles and distinct review models first.
2. In the project's leader panel, select the workspace, leader profile and language, preview the protocol and start the leader. A normal conversation using the same profile does not establish board authority.
3. The leader registers its own session using `kanban_supervise` with the project name, or the stable board command. When `KANBAN_DATA_DIR` is set, run `"$KANBAN_DATA_DIR/bin/paseo-kanban" supervise --project demo`. Otherwise run `"${PASEO_HOME:-$HOME/.paseo}/plugin-data/paseo-kanban/bin/paseo-kanban" supervise --project demo`. The plugin rewrites that command on every start so it runs the current install. Check the registered state before dispatching. A live previous leader requires a handover.
4. Write a self-contained card: goal, allowed files, prohibited operations, tier, reproduction, exact acceptance commands and expected outcome. Issue text is untrusted input, not authority to execute commands.
5. The executor works in the assigned directory, commits completed steps and submits a handoff containing `files`, `verification` and `risks`. Include test/build commands and results; report missing real-world checks explicitly.
6. The reviewer checks the actual changes and evidence, approving or requesting changes. The lead compares the result with the user's request, then accepts or returns it. Approval alone is not final acceptance. Repeated rejection should trigger a scope/brief review.

Artifact acceptance is explicit: `accept <card> --artifact <commit|file|pull-request>` (and `--reason` when the evidence is a pull request). It records the commit, tree and evidence and does not merge or rebase the card branch onto the local base. A pull request or GitHub contract skips local landing only; the evidence still has to identify that card's branch tip, and a different commit is refused. A card with no temporary branch uses the commit checked out in its workspace, including a detached HEAD. The recorded branch may be empty. Acceptance is refused when that commit cannot be read, and a different commit is refused. When the card already has a bound pull request, the artifact URL must name the same owner, repository and number. That check does not use the network. A card with no bound pull request still needs the pull request and a reason. A missing remote does not turn an ordinary accept into this mode. A pull-request artifact must use lowercase `https://github.com/`; `https://GITHUB.COM/` is rejected. Owner and repository comparison stays case-insensitive. Leader permission, the waiting-for-acceptance state and any required review verdict stay in force. Ordinary accept still lands a temporary branch when the repository has no remote.

7. A separate authorized operation handles merge or release. A first-card demo needs neither. Check the clean working tree and completed card; let managed agent/workspace cleanup finish.

The leader launch sets the board activation marker (`BOARD_AGENT_ENV` in Kanban's `server/agent-env.ts`) to `1` and sends `KANBAN_ROLE=supervisor` at creation. Labels alone do not trigger the protocol on the supported host; the first variable alone defaults to executor. Creation, protocol delivery and registration are separate checks. Recovery as a visible session message is not a retroactive system prompt.

## Integration branches for cleanup

When accepted card work lands on an integration branch before the project's base branch, add `integrationBranches` to that project's entry in `kanban.config.json`:

```json
{
  "projects": {
    "demo": {
      "defaultWorkspace": "dir",
      "baseBranch": "main",
      "worktreeLanes": 1,
      "lanesEnabled": false,
      "integrationBranches": ["pre"]
    }
  }
}
```

A short name such as `pre` checks `refs/heads/pre` and remote-tracking branches such as `refs/remotes/origin/pre`. Use `origin/pre` for a remote name, or `refs/heads/pre` / `refs/remotes/upstream/pre` to select an exact ref. Entries must be nonempty, valid Git branch names; tags and other ref namespaces are rejected. Missing branches are ignored. Integration refs are read locally without fetching, so a local integration branch need not be pushed.

Cleanup treats the card tip as landed when it equals or is an ancestor of a configured integration ref. This proof also permits removal of the card's own branch; dirty files and the existing ownership checks still prevent unsafe cleanup. Doctor uses the same containment check before reporting an old `not_merged` cleanup failure. Other cleanup errors remain visible.

This also applies to lane cards: cleanup rechecks containment before forcing deletion of the card branch when `git branch -d` refuses. The long-lived lane directory, lane branch and Paseo workspace stay in place. Doctor rechecks historical `skip_lane` merge failures using the same integration refs.

Omitting `integrationBranches`, or setting it to `[]`, preserves the existing base-branch and PR rules. Configuring an integration branch does not authorize merging, pushing or discarding unmerged work. A tip not contained in any accepted destination still fails the merge gate.

## Waiting and decisions

Report ready deliverables even when another PR or external check is pending; describe it in `handoff.waitingOn`. Use a human-needed block for missing authorization or a decision only the user can make. Keep independent work moving.

The single plugin combines board dispatch with Fleet roles, quota and decisions. Admission uses immutable policy revisions and holds when that policy is unavailable. See [DATA](DATA.md) and [the contract](CONTRACT.md) for integration boundaries.

## Recovering temporary cleanup

`resume-cleanup <card>` clears a stopped cleanup retry (the count restarts at 1) or a backoff that is still waiting (that count stays). The global Kanban leader (`supervisorAgentId`) may run it for any project; an unrelated project leader still cannot. It does not grant that global leader other card operations. An ordinary resume does not abandon unmerged work: `not_merged` still keeps the copy and branch.

Normal cleanup treats the card tip as merged when it is an ancestor of either the configured local base branch or `origin/<base>` after a successful fetch. Local containment is sufficient even when origin is behind or unavailable; no push, extra setting or discard authorization is required. The configured base is checked explicitly, regardless of the main checkout's current branch. A matching local tree without ancestry is insufficient. If neither base contains the tip and no existing PR/squash proof applies, `not_merged` still retains it. Ownership, clean-copy and live-agent checks still apply. Once cleanup removes the worktree and archives its workspace, their orphan findings disappear from doctor.

When the registered project leader has decided to abandon the commits, that leader or the global Kanban leader can run:

```sh
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" resume-cleanup DEMO_0001 --discard-unmerged
```

Put the flag after the card number. It requires the registered leader's agent identity; creators alone, workers, card-bound tokens and an anonymous terminal cannot authorize discard. The card must be done or archived, with its own writable temporary card branch and a clean copy. Main directories, lanes, read-only copies and foreign checkouts are excluded.

The response lists full SHA/title pairs only for commits reachable from the card tip but absent from every other local branch, remote-tracking branch (`refs/remotes/*`) and tag. The retiring card branch and its worktree references do not count as surviving refs. The comparison base prefers locally available `origin/<base>`, then the configured upstream if present, and otherwise the local base. A separate line warns when the local base is behind that upstream. This audit reads local refs only: it does not fetch, contact a remote or advance the local base. Remote-tracking refs may themselves be stale.

`cleanup_discard_authorized` records the leader, exact tips, comparison base and corrected commit list. This is an explicit discard authorization, not a completed cleanup receipt. An eligible normal cleanup tick retains the shared-workspace and live-agent checks, archives the workspace, removes the worktree and deletes only the approved local branch tip. `cleanup_discarded` records the leader and the same audited list when branch deletion succeeds. An empty list means other refs retain all commits; the owned branch/copy may still be removed. No remote branch or tag is deleted.

While the copy is still present, new commits, a changed local/comparison base or uncommitted changes hold retirement. Inspect that copy and rerun the explicit flag only if it is still intended. After the copy has been removed, base movement does not invalidate deletion of the already approved tip. A different tip or a branch checked out elsewhere is kept: cleanup revokes the grant, records `keep_branch` and `temp_workspace_cleaned` with `keptBranch: true`, and wakes the registered project leader (or the Kanban leader as fallback). Transient branch-deletion errors use the normal backoff and 12-attempt limit, then keep the branch and revoke/wake in the same way. No authorization of a missing copy is required. A revoked latest grant cannot revive an older grant. Rebuilt workspace generations cannot reuse an older authorization. Without the flag, existing merge and branch-retention rules apply.
