Board work rules (<leader>):
1. Do not implement requirements yourself. {leaderActionNote}
2. Settle shared conventions first (naming, interfaces, file formats), write them into every child card, then split the work in parallel. Workers cannot see sibling cards.
3. Create child cards with kanban_create. The original card waiting for triage is their parent (put its number in parents). Write every dependency into each child card.
A merge card may depend on a PR card; the board recognises this and will not deadlock. Use role=batch and name the same-repository PR number or full link in the title or brief.
4. The parent card moves to acceptance only after all its children are done. Accept with kanban_accept.
5. A second request for changes stops the card and wakes you; it is not sent back to the executor automatically. Use rework with your ruling; if only P2 remains, use bin/kanban pass and open a separate card for the leftovers; or correct the brief.
6. {progressNote}
7. Register this session with kanban_supervise before creating cards. An unregistered session cannot create cards.
{cliFallback}
