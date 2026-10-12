# Conditional Codex launcher

`bin/codex-kanban-launch` is an executable sh script that needs no build. When
the board marker (`BOARD_AGENT_ENV` in `server/agent-env.ts`) is `1`, it prepends these arguments, then uses `exec` to run Codex:

```text
-c memories.generate_memories=false -c features.memories=false
```

Without that marker, it passes the original arguments through. Standard input,
output, exit status and signals reach the executable directly. The board's
dispatch entry sets the marker for executor, reviewer, reader, decision and batch
agents. The wrapper does not read or write Codex configuration or credentials.

## Installed path and Paseo configuration

The npm package explicitly includes `bin/codex-kanban-launch`; it is a shell
launcher, so it is not part of the generated `*.bundle.mjs` files. Find the
installed plugin directory with `paseo plugin ls --json` and append
`/bin/codex-kanban-launch` to its directory. Use the persistent installed package,
not a disposable development checkout. The script must remain executable.

For Paseo 0.11.2, the persistent configuration field is
`agents.providers.codex.command`, an argv array. Merge the following fields into
the configuration for the intended Paseo home, substituting your own paths:

```json
{
  "agents": {
    "providers": {
      "codex": {
        "command": ["/absolute/path/to/installed/paseo-kanban/bin/codex-kanban-launch"],
        "env": {
          "KANBAN_REAL_CODEX": "/absolute/path/to/codex"
        }
      }
    }
  }
}
```

Paseo translates this field into its internal replacement command. Do not add
`runtimeSettings` to the persistent JSON. Keep existing provider environment
values and any existing command arguments after the launcher path. For example,
replace `["/custom/codex", "-c", "some_setting=value"]` with
`["/absolute/path/to/installed/paseo-kanban/bin/codex-kanban-launch", "-c", "some_setting=value"]`
and set `KANBAN_REAL_CODEX` to `/custom/codex`. Later explicit memory overrides
can override the arguments the wrapper prepends; avoid conflicting arguments.

`KANBAN_REAL_CODEX` accepts an executable path or a single command name, without
arguments. If omitted, the wrapper walks PATH for `codex`, skipping its own
symlink and hardlink aliases. Missing executables and recursive launches exit
127. File identity checks use `test -ef`, supported by macOS/Linux sh.

Keep the board marker out of the provider's global environment and the daemon's
environment: the board sets it for each launched agent. After saving the old
command and related environment values, an operator can apply the configuration
with `paseo --home "$PASEO_HOME" reload`. Existing agents keep their current
process arguments. Restore those saved fields and reload to roll back.

## Local checks and optional diagnostics

```sh
node --import tsx --test test/codex-kanban-launch.test.ts
npm run pack:check
```

Tests run a fake Codex and check conditional arguments, exact argument framing,
PATH resolution, alias rejection and exit status. They do not launch a daemon.

For a short operator-controlled check, set `KANBAN_CODEX_WRAPPER_LOG` to an
explicit disposable file. Each invocation appends `argc\0arg1\0...argN\0` after
the overrides are applied. Environment values are never logged. The log captures
app-server startup arguments; prompts and MCP configuration that Paseo sends
later are outside those arguments. If another invocation supplies sensitive
values as arguments, those values will be recorded. Remove this diagnostic
setting after the check.

An unmarked Paseo invocation should contain only its original arguments. A board
invocation should contain both overrides before those arguments. This verifies
the startup path. A brief comparison without a background consolidation event
does not prove that consolidation was suppressed. No live startup or memory
behavior was validated by this public port.
