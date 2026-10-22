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

Review requires two distinct, nonempty actual models after trim/lower normalization. Models in one family may review each other; one model across providers or settings may not. Missing evidence holds automatic review. A scoped leader can recover legacy deliveries through an explicitly selected profile and a recorded reason; see [review scheduling and legacy recovery](REVIEW-SCHEDULING.md). High-risk work still requires a qualified independent reviewer and lead acceptance. The default reviewer matrix lists an independent Codex `gpt-6-sol` slot at `high` on L1 through L4. That slot matches model `gpt-6-sol` exactly and does not use the GPT-6.1 marker.

A separately created reviewer card with `--reviews <target>` records its verdict through `approve <review-card> --summary "<evidence>"`, or `kanban_approve` with its own card id (which may be omitted). Approval checks the review card's own contract. If the target is still `in_review`, the current assigned review agent has a recorded run with a different actual model from the target's execution run, and no other review is reserved, running or already approved, both cards enter `acceptance` in one transaction. The target's `approve` event records the review card, agent, run and actual models. Its contract, executor, handoff and review round stay intact, and the scheduler does not start another automatic review for that accepted review result.

Missing or same-model evidence, another review, or changed delivery evidence leaves the target in place while recording the review card's approval. Both cards explain why; for an `in_review` target, the lead can inspect that evidence and use `pass <target> --note "<reason>"`. Explicit legacy startup authorization does not supply a missing executor model for this automatic transition. Deferred PR checks retain the submitting reviewer and delivery evidence and recheck them before advancing. See [linked approval rules](REVIEW-SCHEDULING.md#approving-a-linked-review). Worker tokens remain limited to their own card and current assigned agent, including when the target is readable through `--reviews` or a project read grant. Reviewers cannot directly pass, accept or change the target's other states. Lead acceptance remains separate.

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

For a command that takes more than a few minutes, use one foreground invocation with a sufficient timeout, or detach it and register `paseo-kanban wait-bg "$KANBAN_TMP/job.exit" --card <card> --log "$KANBAN_TMP/job.log"`. The detached shell writes its exit code (0 through 255) to a fresh pending file, then atomically renames it to the exit marker when finished. Register before ending the agent turn. The board checks that marker during its normal server tick and sends one result message, including at most 8 KiB from the log tail. It persists the wait and message receipt across restarts and excludes the waiting card from idle/stall and human-attention checks. Do not repeatedly call wait/sleep to poll progress. A missing marker continues waiting; invalid markers or replaced temporary directories produce an error wake. The board must stay running, and the command must survive the turn ending. A scoped leader can cancel with `unblock`. A pending command still needs its result checked before the card is complete. See the injected work rules or CLI help for a shell example.

Default candidates follow model capability. Max is available only when the card explicitly requests `--effort max` or `--tag needs-max`; `hard-code` alone does not authorize it. A lower explicit effort is preserved. The executor request does not raise an automatic review. Legacy matrix/profile max values are capped before use, and generated matrices never contain max. Resuming an existing agent retains its original depth.

| Card type | L1 | L2 | L3 | L4 |
| --- | --- | --- | --- | --- |
| Execution | GPT-6-Luna medium | GPT-6.1-Sol medium | GPT-6.1-Sol high | GPT-6.1-Sol xhigh |
| Batch | GPT-6-Luna medium | GPT-6-Luna medium | GPT-6-Luna medium | GPT-6-Luna medium |
| Review | GPT-6-Luna high | GPT-6-Luna high | GPT-6.1-Sol high | GPT-6.1-Sol high |
| Deploy / wait / data move / operations | Luna or Grok low | Luna or Grok low | Luna or Grok low | Luna or Grok low |

Reviews still require a different actual model from the executor; the matrix retains independent alternatives when the first candidate has that same model. Existing quota ordering, pauses and capability checks still apply. On executor and batch cards, the tags `ops`, `operations`, `deploy`, `deployment`, `wait`, `data-move`, `data-migration`, `release`, `release-rehearsal` and `maintenance` select the operations route at every tier, including explicit profile or effort overrides. Only configured Luna/Grok profiles from that role's matrix may run it. Missing or unavailable light profiles leave the card waiting; Sol is not an operations fallback. Untagged cards use conservative deployment/wait/data-move title prefixes or a brief line such as `Task type: deploy`. Explicit `code`/`hard-code` tags disable the heuristic; an operations tag wins when both are present. The dedicated `ops_*` lists default to low while preserving explicitly configured role-specific profiles and depths. Background waiting itself does not call a model.

The base is `shared/fleet/default-dispatch.example.json`. Fleet merges `fleet/afc.config.json`'s `dispatchOverrides`, generates `fleet/dispatch-matrix.json`, and publishes the immutable policy. The examples include the capability defaults and three exact-model Luna profiles (`executor.gpt-6-luna`, `reviewer.gpt-6-luna`, `batch.gpt-6-luna`). The Luna examples explicitly use `featureValues.service_tier=default`. Add or update those profiles in the host configuration while preserving other profiles and role metadata. Use the default/override values shown in `examples/afc.config.example.json`; install the new code and let Fleet regenerate matrix and policy. Do not hand-edit generated policy files. Review overrides now use Luna high at L1/L2 and Sol high at L3/L4.


The single plugin combines board dispatch with Fleet roles, quota and decisions. Admission uses immutable policy revisions and holds when that policy is unavailable. See [DATA](DATA.md) and [the contract](CONTRACT.md) for integration boundaries.

## Recovering temporary cleanup

An eligible dispatched operations batch card can inspect other projects and retry cleanup of done/archived cards without becoming a leader. See [operations cleanup permissions](OPS-CLEANUP.md) for configuration, token/run binding, allowed commands and expiry. Ordinary project-read grants keep their existing same-project scope.

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

## Recovering a missing landing branch

An accepted card can wait in `land_pending` while its main checkout is dirty. Each observation now saves the exact queued branch tip. If that branch disappears, the scheduler checks local branches, remote-tracking branches and tags without fetching. When one contains the saved tip, it writes `land_settled` with the tip, retaining ref and resolved commit, then releases the landing hold. This also covers a card with no commits beyond its base. An existing dirty, changed or unreadable card copy prevents automatic settlement. The main checkout may remain dirty because this recovery does not merge into it.

If the saved tip is absent, unreadable or not retained, automatic landing stops and the registered leader receives a separate missing-branch notice. The scheduler continues read-only checks so a restored branch can resume normal landing or newly retained commits can settle. It does not infer the completed tip from the worktree creation base, a missing directory, an archived status or a matching tree. Old queue events without a saved tip therefore require explicit inspection. Doctor reports the missing branch with recovery advice; an unreadable branch listing remains unknown rather than proof of absence.

After checking that no local landing is needed, the registered project leader or global Kanban leader may explicitly close this queue:

```sh
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" resume-cleanup DEMO_0001 --settle-missing-land --reason "Installation-only work; the accepted release evidence was checked separately."
```

Use the registered leader's agent identity. Card-bound tokens, card creators who are not registered leaders, unrelated project leaders and anonymous shells are refused. A nonempty reason is required. The card must be done or archived, the queued branch/base must match its owned temporary worktree record, and Git must confirm that the exact local branch is missing. The flag cannot be combined with `--discard-unmerged`. A restored branch or changed queue invalidates the operation.

The audit event is `land_settled`, with `mode: leader`, the authorizing identity, reason, original pending event, branch/base, saved tip (or null), available unretained SHA/title pairs and inspection evidence. Automatic settlement uses `mode: retained`. Neither mode writes `landed`, merges code, recreates a branch or grants discard authorization. A newer queue is not hidden by an older settlement. Normal cleanup resumes on an eligible tick and keeps its independent ownership, dirty-copy and live-agent checks.

This extends `resume-cleanup` because the stranded landing hold prevents cleanup of an already accepted card. Reusing `accept` would require reopening an archived card and could repeat acceptance or merge work. Reusing `--discard-unmerged` would conflate closing a missing-branch queue with permission to delete an existing branch. Historical installation-only cards with no recorded tip can use the explicit command after their release evidence has been checked; an upgrade alone will hold and notify instead of guessing.
