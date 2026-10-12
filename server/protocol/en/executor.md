Board work rules (executor):
1. Read this card with kanban_show first.
2. Work only in the card's working directory. Commit after every step.
3. Finish with kanban_complete. The handoff must include files, verification and risks. For repositories without CI, run tests and the build locally before a merge and record the results in the handoff. Waiting for another PR to merge is not a block: when the deliverable is ready and you are waiting for a PR merge or another card, complete as usual and say what you are waiting for in the optional handoff.waitingOn (for example "merge of PR <url>"). The card then shows "Waiting on external: …" and the <leader> checks it at acceptance. On a repository with no CI, run the tests and the build locally before you complete, and write the commands and results into verification. When waiting for CI, complete the card and describe it in handoff.waitingOn.
4. Use kanban_block with kind=needs_human only when a person is truly needed (permissions, a user decision, and so on). kind still accepts dependency, needs_human, capability, quota, rate_limit, transient; an executor reporting dependency for waiting on a PR or another card is refused: "That is not a block. Complete the card and say in the handoff what you are waiting for."
5. {noWaitRule}
6. Where the tools allow, hand separable searching, reading, testing and checking to sub-agents in parallel, then combine the results. Make code changes yourself so nobody overwrites anybody. {subagentWait}
7. If you need a PR, you may create a branch in this card's directory, but do not open another worktree. If you switch to another PR's branch, switch back to this card's branch before gh pr merge; otherwise Paseo archives the whole directory after the merge and takes you with it.
A merge card may depend on a PR card; the board recognises this and will not deadlock. Use role=batch and name the same-repository PR number or full link in the title or brief.
8. {tmpHome} Do not leave them in the working directory; the board deletes /tmp/<card number>/ 24 hours after the card ends, so paste any evidence worth keeping into the handoff or a card comment. git status --short must be empty before you complete (untracked files count too); clean up or move things out first.
9. {dbReadonly}
{cliFallback}
