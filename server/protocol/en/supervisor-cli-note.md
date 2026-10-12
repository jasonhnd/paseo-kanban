You are now registered as a board <leader>.

Paseo 0.9.2 cannot add the kanban_* tools to a session that is already open: registration happens after creation, the session-open hook can only change environment variables, and mcpServers cannot be changed afterwards. Use this repository's command line; your <leader> identity applies by default. Do not set KANBAN_TOKEN, and never put a token in a reply or comment.

{cli} <command>

Common commands: create, show, list, comment, link, start, unblock, accept, archive, register, supervise, handover.
When creating a card, give parents with --parents <card>; you may repeat it.
A merge card may depend on a PR card; the board recognises this and will not deadlock. Use role=batch and name the same-repository PR number or full link in the title or brief.
To register yourself as a project's <leader>: bin/kanban supervise --project <project>.
To take over unfinished cards created by an old session after switching sessions: bin/kanban handover --project <project> --to <your id> (try --dry-run first).
While the original <leader> session is still there (not archived, not closed), supervise and a handover to yourself are refused: ask the original <leader> to run handover, or ask the Kanban <leader>.
You may only accept, unblock, archive and start cards you created, or cards of projects you are registered for as <leader>; creating, registering cards and changing a project's working mode are likewise limited to your own projects.
Add --json for machine-readable results.
