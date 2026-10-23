import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudTaskScript } from "../server/cloud-script";
import { executable } from "../scripts/isolated-environment.mjs";

for (const arch of ["x64", "aarch64"] as const) test(`Bun ${arch} release installs from a real checked ZIP without executing a remote script`, () => {
  const root = mkdtempSync(join(tmpdir(), "bun-release-"));
  try {
    const home = join(root, "home");
    const tools = join(root, "tools");
    const source = join(root, "source");
    const scratch = join(root, "scratch");
    for (const dir of [home, tools, scratch, join(source, `bun-linux-${arch}`)]) mkdirSync(dir, { recursive: true });
    const bun = join(source, `bun-linux-${arch}`, "bun");
    writeFileSync(bun, "#!/bin/sh\nprintf '1.4.2\\n'\n"); chmodSync(bun, 0o755);
    const archive = join(root, "release.zip");
    execFileSync(executable("zip"), ["-q", archive, `bun-linux-${arch}/bun`], { cwd: source });
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    for (const [name, body] of Object.entries({
      uname: `printf '${arch === "x64" ? "x86_64" : "aarch64"}\\n'`,
      curl: 'while [ "$1" != "--output" ]; do shift; done; cp "$FIXTURE_ARCHIVE" "$2"',
    })) {
      writeFileSync(join(tools, name), `#!/bin/sh\n${body}\n`); chmodSync(join(tools, name), 0o755);
    }
    const render = (sha: string) => cloudTaskScript({
      repo: "example/demo", branch: "task/demo", base: "main", source: "main", provider: "codex", model: "demo",
      effort: null, prompt: "Update fixture", timeoutSec: 60, installCommand: ["npm", "ci"], testCommand: ["npm", "test"], directories: ["."],
      installBun: true, bunVersion: "1.4.2", bunSha256: { "1.4.2": { [arch]: sha } },
    }).split("export GIT_AUTHOR_NAME=")[0];
    const env = { ...process.env, HOME: home, PATH: `${tools}:/usr/bin:/bin:/sbin`, KANBAN_TMP: scratch, TMPDIR: scratch, FIXTURE_ARCHIVE: archive };
    const good = spawnSync("/bin/bash", ["-c", render(digest)], { env, encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(execFileSync(join(home, ".bun/bin/bun"), ["--version"], { env, encoding: "utf8" }).trim(), "1.4.2");
    assert.equal(existsSync(join(scratch, "bun-release")), false);
    rmSync(join(home, ".bun"), { recursive: true });
    const bad = spawnSync("/bin/bash", ["-c", render("0".repeat(64))], { env, encoding: "utf8" });
    assert.equal(bad.status, 81);
    assert.match(bad.stdout, /PKB_RUNTIME_FAILURE=bun installation failed/);
    assert.equal(existsSync(join(home, ".bun/bin/bun")), false);
    assert.equal(existsSync(join(scratch, "bun-release")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
