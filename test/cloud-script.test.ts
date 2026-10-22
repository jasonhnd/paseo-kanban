import assert from "node:assert/strict";
import { test } from "node:test";
import { cloudTaskScript } from "../server/cloud-script";

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
