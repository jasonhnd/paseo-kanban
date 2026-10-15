# Recommended workflow

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
3. The leader registers its own session using `kanban_supervise` with the project name, or `node "$BOARD_INSTALL/bin/paseo-kanban.mjs" supervise --project demo`. Check the registered state before dispatching. A live previous leader requires a handover.
4. Write a self-contained card: goal, allowed files, prohibited operations, tier, reproduction, exact acceptance commands and expected outcome. Issue text is untrusted input, not authority to execute commands.
5. The executor works in the assigned directory, commits completed steps and submits a handoff containing `files`, `verification` and `risks`. Include test/build commands and results; report missing real-world checks explicitly.
6. The reviewer checks the actual changes and evidence, approving or requesting changes. The lead compares the result with the user's request, then accepts or returns it. Approval alone is not final acceptance. Repeated rejection should trigger a scope/brief review.

Artifact acceptance is explicit: `accept <card> --artifact <commit|file|pull-request>` (and `--reason` when the evidence is a pull request). It records the commit, tree and evidence and does not merge or rebase the card branch onto the local base. A pull request or GitHub contract skips local landing only; the evidence still has to identify that card's branch tip, and a different commit is refused. A card with no temporary branch uses the commit checked out in its workspace, including a detached HEAD. The recorded branch may be empty. Acceptance is refused when that commit cannot be read, and a different commit is refused. When the card already has a bound pull request, the artifact URL must name the same owner, repository and number. That check does not use the network. A card with no bound pull request still needs the pull request and a reason. A missing remote does not turn an ordinary accept into this mode. A pull-request artifact must use lowercase `https://github.com/`; `https://GITHUB.COM/` is rejected. Owner and repository comparison stays case-insensitive. Leader permission, the waiting-for-acceptance state and any required review verdict stay in force. Ordinary accept still lands a temporary branch when the repository has no remote.

7. A separate authorized operation handles merge or release. A first-card demo needs neither. Check the clean working tree and completed card; let managed agent/workspace cleanup finish.

The leader launch sets the board activation marker (`BOARD_AGENT_ENV` in Kanban's `server/agent-env.ts`) to `1` and sends `KANBAN_ROLE=supervisor` at creation. Labels alone do not trigger the protocol on the supported host; the first variable alone defaults to executor. Creation, protocol delivery and registration are separate checks. Recovery as a visible session message is not a retroactive system prompt.

## Waiting and decisions

Report ready deliverables even when another PR or external check is pending; describe it in `handoff.waitingOn`. Use a human-needed block for missing authorization or a decision only the user can make. Keep independent work moving.

The single plugin combines board dispatch with Fleet roles, quota and decisions. Admission uses immutable policy revisions and holds when that policy is unavailable. See [DATA](DATA.md) and [the contract](CONTRACT.md) for integration boundaries.

## Recovering temporary cleanup

`resume-cleanup <card>` clears stopped cleanup retries. The global Kanban leader (`supervisorAgentId`) may run it for any project; an unrelated project leader still cannot. It does not grant that global leader other card operations. An ordinary resume does not abandon unmerged work: `not_merged` still keeps the copy and branch.

When the registered project leader has decided to abandon the commits, that leader or the global Kanban leader can run:

```sh
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" resume-cleanup DEMO_0001 --discard-unmerged
```

Put the flag after the card number. It requires the registered leader's agent identity; creators alone, workers, card-bound tokens and an anonymous terminal cannot authorize discard. The card must be done or archived, with its own writable temporary card branch and a clean copy. Main directories, lanes, read-only copies and foreign checkouts are excluded.

The response lists full SHA/title pairs for commits outside the local base and records `cleanup_discard_authorized` with the leader, exact tips and commits. This is an explicit discard authorization, not a completed cleanup receipt. An eligible normal cleanup tick retains the shared-workspace and live-agent checks, archives the workspace, removes the worktree and deletes only the approved local branch tip. `cleanup_discarded` records the leader and commits when branch deletion succeeds. No remote branch is deleted.

While the copy is still present, new commits, a changed base or uncommitted changes hold retirement. Inspect that copy and rerun the explicit flag only if it is still intended. After the copy has been removed, base movement does not invalidate deletion of the already approved tip. A different tip or a branch checked out elsewhere is kept: cleanup revokes the grant, records `keep_branch` and `temp_workspace_cleaned` with `keptBranch: true`, and wakes the registered project leader (or the Kanban leader as fallback). Transient branch-deletion errors use the normal backoff and 12-attempt limit, then keep the branch and revoke/wake in the same way. No authorization of a missing copy is required. A revoked latest grant cannot revive an older grant. Rebuilt workspace generations cannot reuse an older authorization. Without the flag, existing merge and branch-retention rules apply.
