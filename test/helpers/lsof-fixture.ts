import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** An anonymous executable protocol fixture; it never inspects native processes. */
export function lsofFixture(directory: string, response: ({ files: string[] } | { groups: string[][] }) & { stdout?: string; stderr?: string; status: number }): string {
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, "lsof");
  writeFileSync(executable, [
    "#!/usr/bin/env node",
    "import assert from 'node:assert/strict';",
    "import { existsSync } from 'node:fs';",
    "import { isDeepStrictEqual } from 'node:util';",
    `const response = ${JSON.stringify(response)};`,
    "const expected = response.groups ? response.groups.map(files => files.filter(existsSync)) : [response.files];",
    "assert.ok(expected.some(files => isDeepStrictEqual(process.argv.slice(2), ['-F', 'pcf', '--', ...files])), 'unexpected inspection arguments');",
    "process.stdout.write(response.stdout ?? '');",
    "process.stderr.write(response.stderr ?? '');",
    "process.exitCode = response.status;",
    "",
  ].join("\n"));
  chmodSync(executable, 0o755);
  return directory;
}
