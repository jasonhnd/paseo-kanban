import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudDraftPrBody, cloudTaskScript } from "../server/cloud-script";
import type { CloudRunnerConfig } from "../server/cloud-config";

for (const effort of [null, "medium"]) {
  test(`cloud Codex command uses standard speed (effort=${effort})`, () => {
    const script = cloudTaskScript({
      repo: "example/demo", branch: "task/demo", base: "main", source: "main",
      provider: "codex", model: "demo-model", effort, prompt: "Update the fixture.",
      timeoutSec: 60, installCommand: ["npm", "ci"], testCommand: ["npm", "test"], directories: ["."],
    });
    assert.match(script, /codex exec .*--model 'demo-model'/);
    assert.doesNotMatch(script, /service[_-]?tier|priority|fast/i);
    if (effort) assert.match(script, /model_reasoning_effort="medium"/);
  });
}

for (const fixture of [
  { runtime: "npm" as const, installCommand: ["npm", "ci"], testCommand: ["npm", "test"], expectedInstall: "npm ci", expectedTest: "npm test" },
  { runtime: "bun" as const, installCommand: ["bun", "install", "--frozen-lockfile"], testCommand: ["bun", "run", "test"], expectedInstall: "bun install --frozen-lockfile", expectedTest: "bun run test" },
]) {
  test(`cloud prompt and draft PR use configured ${fixture.runtime} validation commands`, () => {
    const config = { ...fixture, directories: ["."] } as Pick<CloudRunnerConfig, "runtime" | "installCommand" | "testCommand" | "directories">;
    const script = cloudTaskScript({
      repo: "example/demo", branch: "task/demo", base: "main", source: "main", provider: "codex", model: "demo-model",
      effort: null, prompt: "Update the fixture.", timeoutSec: 60, ...fixture, runtime: fixture.runtime, directories: ["."],
    });
    const prompt = Buffer.from(script.match(/echo ([A-Za-z0-9+/=]+) \| base64 -d > "\$KANBAN_TMP\/prompt\.md"/)![1], "base64").toString();
    assert.ok(prompt.includes(`The host will run ${fixture.expectedInstall} and ${fixture.expectedTest} in .`));
    assert.ok(cloudDraftPrBody(config).includes(`Validation: .: ${fixture.expectedInstall} and ${fixture.expectedTest} passed.`));
    assert.doesNotMatch(prompt, /\/Users\/|PKP_\d+|home\//);
    assert.doesNotMatch(cloudDraftPrBody(config), /\/Users\/|PKP_\d+|home\//);
  });
}

test("cloud validation text honors directory-specific commands", () => {
  const config = {
    runtime: "bun", installCommand: ["bun", "install"], testCommand: ["bun", "test"],
    directories: [{ path: "web", installCommand: ["bun", "install", "--cwd", "web"], testCommand: ["bun", "run", "test:web"] }],
  } as unknown as Pick<CloudRunnerConfig, "runtime" | "installCommand" | "testCommand" | "directories">;
  assert.match(cloudDraftPrBody(config), /web: bun install --cwd web and bun run test:web passed/);
});


test("public checkout uses the repository name instead of a fixed project directory", () => {
  const script = cloudTaskScript({
    repo: "example/demo-web", branch: "task/demo", base: "main", source: "main",
    provider: "codex", model: "demo-model", effort: null, prompt: "Update the fixture.",
    timeoutSec: 60, installCommand: ["npm", "ci"], testCommand: ["npm", "test"], directories: ["."],
  });
  assert.ok(script.includes("'https://github.com/example/demo-web.git'"));
  assert.ok(script.includes(`work="$HOME/work"/'demo-web'`));
  assert.doesNotMatch(script, /paseo-clear-chat/);
});

for (const repo of ["example/.", "example/..", "example/", "example/bad name", "example/$(echo unsafe)", "example/bad'quote"]) {
  test(`public checkout falls back to a safe directory for ${repo}`, () => {
    const script = cloudTaskScript({
      repo, branch: "task/demo", base: "main", source: "main",
      provider: "codex", model: "demo-model", effort: null, prompt: "Update the fixture.",
      timeoutSec: 60, installCommand: ["npm", "ci"], testCommand: ["npm", "test"], directories: ["."],
    });
    assert.ok(script.includes(`work="$HOME/work"/'repository'`));
  });
}
test("draft receipt describes actual optional skips instead of successful commands", () => {
  const config = { runtime: "npm", installCommand: ["npm", "ci"], testCommand: ["npm", "test"],
    directories: [{ path: "astro", optional: true }, { path: "pipeline", skipTest: true }] } as Pick<CloudRunnerConfig, "runtime" | "installCommand" | "testCommand" | "directories">;
  const body = cloudDraftPrBody(config, "codex", "PKB_DIRECTORY_SKIPPED=install:0\nPKB_DIRECTORY_SKIPPED=test:0\n");
  assert.match(body, /astro: skipped \(optional, missing\)/);
  assert.match(body, /pipeline: skipped test \(skipTest\)/);
  assert.doesNotMatch(body, /astro: [^;]*passed/);
});

test("Bun installation refuses absent version digests before rendering remote commands", () => {
  const input = {
    repo: "example/demo", branch: "task/demo", base: "main", source: "main",
    provider: "codex" as const, model: "demo-model", effort: null, prompt: "Update the fixture.",
    timeoutSec: 60, installCommand: ["npm", "ci"], testCommand: ["npm", "test"], directories: ["."],
    installBun: true, bunVersion: "9.9.9", bunSha256: { "1.4.2": { x64: "a".repeat(64) } },
  };
  assert.throws(() => cloudTaskScript(input), /bunSha256 for the exact bunVersion/);
  assert.throws(() => cloudTaskScript({ ...input, bunVersion: "1.4.2", bunSha256: { "1.4.2": { x64: "invalid" } } }), /bunSha256/);
  const script = cloudTaskScript({ ...input, installBun: false });
  assert.doesNotMatch(script, /curl|unzip|sha256sum/);
  assert.match(script, /bun version mismatch or missing; expected 9.9.9/);
});
