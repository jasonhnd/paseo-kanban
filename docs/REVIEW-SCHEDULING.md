# Review scheduling and legacy recovery

Completing an executor card reserves its automatic review on that same card. `in_review` means scheduled; `reviewing` means in progress. A separate reviewer card reserves the delivery named by `--reviews`. Titles do not establish a review relationship.

The board card, drawer, `show`, and leader `list` output expose `reviewStatus`, including the review card code, automatic/manual placement, and the selected profile when recorded. A linked review with no selected profile still shows its card code. A blocked review remains reserved so its problem cannot silently create another review.

## Avoiding duplicate reviews

Before creating a linked review, check the delivered card's review assignment. Creation refuses an existing automatic review or an unfinished linked review, naming its card and state. The check and insert share one transaction, including independent CLI processes. Retrying the same idempotency key returns the original card.

The same check applies when execution completes, including its first completion from `running`. If a linked review was created while execution was still running, completion refuses to reserve an automatic review and names that linked card. The delivery, handoff and work run stay unchanged. Archive the premature linked review before retrying completion. The reservation check and automatic submission share the same write lock as linked creation, so concurrent processes cannot schedule both. Quiet automatic handoff also refuses an existing reservation, logs its card code, and leaves the delivery running.

A linked review stops reserving its target at `acceptance`, `done`, or `archived`. To replace an unfinished review, finish it or explicitly archive it first. Existing duplicate rows are retained for inspection; the first reservation owns the start. Startup checks again after asynchronous preparation, before opening an agent. Repeating `start` or executor completion also identifies an existing review.

Scheduling does not infer targets from titles. Lead acceptance remains separate.

## Approving a linked review

The assigned reviewer submits `approve <review-card> --summary "<evidence>"`, or calls `kanban_approve` with its own card id (which may be omitted). The review card's own contract must pass first. Its approval also advances the linked target from `in_review` to `acceptance` when all these conditions hold:

1. The review card explicitly names the target through `reviews`, and the submitting agent and latest review run match the board's current assignment.
2. The latest execution run matches the target's executor binding, and both actual models are recorded and different after trim/lower normalization. Models in the same family may differ; different providers, effort or modes cannot make one model independent. Current profiles and legacy startup exceptions do not replace missing run evidence.
3. There is no other unfinished linked review or approving verdict from another linked or inline review. An archived review with an approving verdict still counts; an archived unfinished review or finished request-changes verdict does not. A queued automatic reservation on the target itself is not another running review.

The review verdict and target transition share one SQLite write transaction with review creation and reservation checks. The target receives an `approve` audit event recording `reviewTaskId`, `reviewCard`, `reviewerAgentId`, `reviewerRunId`, `reviewerModel`, `executorRunId` and `executorModel`. Normal acceptance notification and worker retirement follow, as with leader `pass`. The target's contract, executor binding, handoff and review round remain intact. Its new `acceptance` state removes it from automatic review scheduling.

When a condition fails, the review card still records approval and both cards explain why the target stayed in place. For a target still in `in_review`, the explanation names `pass <target> --note "<reason>"` for the leader's inspected ruling. Other target states remain unchanged. A missing target is explained on the review card. The reviewer cannot directly write to the target or invoke leader-only pass/accept operations; normal own-card and current-agent permission checks remain enforced. Request-changes keeps its existing behavior, and final acceptance remains the leader's decision.

Pending PR checks store the approval's assigned agent, review run and target delivery evidence in the board-owned `pr_wait` event. Polling rechecks current runs and competing reviews under the write lock. Reviewer reassignment invalidates the pending submission and requires a fresh approval. A resubmitted target or an older pending check with no recorded binding cannot automatically advance the target.

## Recovering missing historical execution evidence

Automatic target-bound review still stops when its executor model or actual work run is unavailable. It does not infer an actual model from current profile names, providers, family labels, or an earlier reviewer run. A missing target or an ambiguous executor binding still requires repairing that evidence.

A leader can explicitly select a reviewer for a delivered legacy card:

```sh
paseo-kanban start DEMO_0001 \
  --profile "Review Example" \
  --reason "The imported delivery has no reliable executor model; I inspected the available artifact and selected this reviewer."
```

Use the card that needs review startup: the original executor card for its automatic review, or the existing linked reviewer card. The command also supports old standalone reviewer cards with no `reviews` association. Their earlier reviewer model is not treated as an executor model. If the old review is already archived, create a replacement reviewer card for the existing artifact, record that artifact and the missing association in its brief, and use the same explicit startup command; the execution does not need to be redone.

Both arguments are required and the reason must be nonempty. Only the scoped leader can authorize this route. The chosen profile must be a reviewer, or a candidate for reviewer, with an explicit actual model. Missing-model messages give the command; a standalone `needs_human` reviewer with no work binding shows a conditional recovery hint in its drawer and blocked-start error. Other human decisions must be resolved before using that hint.

The command records the leader, reason, exact reviewer profile/provider/model, and current delivery evidence in a `review_profile_authorized` event. It adds a readable comment to the review card and its linked target, when present. A blocked review returns to its review queue, and the previous reviewer run is closed and retired through the normal agent cleanup path. Execution evidence and the delivered artifact are preserved.

Quota, pool-role restrictions, provider policy, effort support, and concurrency still apply. A quota retry keeps the authorized profile; it cannot select another available profile. The authorization expires after changed execution evidence, a new work run, rework, or resubmission. Known executor models always use the ordinary distinct-model check, including evidence recovered during an awaited startup operation. A changed reviewer model/provider is refused until the leader restores or reauthorizes that profile.

This is an audited manual exception for missing history. It does not reconstruct the executor model or prove historical model independence. The reviewer prompt states that limit and the leader's reason explicitly. A successful review still goes to the normal verdict/acceptance workflow; it does not merge, publish, or perform final acceptance.
