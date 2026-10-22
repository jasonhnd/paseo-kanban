// End to end: the real .githooks/pre-commit and pre-push in a throwaway repository with a copy of the gates.
// Personal-looking samples are assembled at run time so this file scans clean.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATES = ["scripts/check-private.mjs", "scripts/private-identifiers.mjs", "scripts/git-objects.mjs", "scripts/check-identity.mjs", "scripts/private-scan.rules.json", "scripts/check-publication.mjs", "scripts/verify-ref.mjs", "scripts/isolated-environment.mjs", "scripts/shared-runtime.mjs", "scripts/test-node.mjs", ".githooks/pre-commit", ".githooks/pre-push"];
GATES.push("shared/privacy-denylist.mjs", "shared/public-identity.mjs");
const j = (...parts) => parts.join("");
const PLACEHOLDER = "noreply@example.invalid";
const PERSONAL = j("someone", "@", "mail.test.org");
const TERM = j("Hidden", "Project");

let home;
let repo;
let remote;
let env;

const git = (args, extra = {}) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...env, ...extra } });
const ok = (result) => {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
};

// Manufacture poisoned anonymous history with Git plumbing; never disable a real hook.
function unsafeCommit(message, extra = {}) {
  const tree = ok(git(["write-tree"])).stdout.trim();
  const parent = ok(git(["rev-parse", "HEAD"])).stdout.trim();
  const id = ok(git(["commit-tree", tree, "-p", parent, "-m", message], extra)).stdout.trim();
  ok(git(["update-ref", "HEAD", id]));
  return id;
}

function hookAt(tip, remoteRef = "refs/heads/demo") {
  return spawnSync("sh", [".githooks/pre-push"], { cwd: repo,
    input: `refs/heads/demo ${tip} ${remoteRef} ${"0".repeat(40)}\n`, encoding: "utf8", env });
}

/** Stage one file and try to commit it through the hooks. */
function tryCommit(file, body, extra = {}) {
  writeFileSync(join(repo, file), body);
  ok(git(["add", file]));
  const result = git(["commit", "-q", "-m", `add ${file}`], extra);
  if (result.status !== 0) ok(git(["reset", "-q", "HEAD", "--", file]));
  rmSync(join(repo, file), { force: true });
  return result;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "hooks-test-"));
  repo = join(home, "repo");
  remote = join(home, "remote.git");
  const list = join(home, "denylist.txt");
  writeFileSync(list, `# demo list\n${TERM}\n`);
  // No global or system git config: only the repository's own settings apply.
  env = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "no-global"), FLEET_PRIVATE_DENYLIST: list };
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete env[key];
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  execFileSync("git", ["init", "-q", "--bare", remote], { env });
  for (const file of GATES) cpSync(join(ROOT, file), join(repo, file));
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"), "dir");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  // Exact-tree verification is exercised here with an anonymous package and an explicit verifier stub.
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", private: true, scripts: { verify: "node verify-stub.mjs" } }));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ name: "demo", lockfileVersion: 3, packages: { "": { name: "demo" } } }));
  writeFileSync(join(repo, "verify-stub.mjs"), "console.log('ANONYMOUS_VERIFIER_CALLED');\n");
  // Hook wiring tests do not claim secret-scanner acceptance. Real publication requires real gitleaks.
  const tools = join(home, "tools"); mkdirSync(tools);
  writeFileSync(join(tools, "gitleaks"), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  env.PATH = tools + delimiter + (env.PATH ?? "");
  ok(git(["config", "core.hooksPath", ".githooks"]));
  ok(git(["config", "user.name", "paseo-fleet contributors"]));
  ok(git(["config", "user.email", PLACEHOLDER]));
  ok(git(["remote", "add", "origin", remote]));
  ok(git(["add", "-A"]));
  ok(git(["commit", "-q", "-m", "gates"]));
});

after(() => rmSync(home, { recursive: true, force: true }));

describe("pre-commit", () => {
  test("a clean file is committed", () => {
    writeFileSync(join(repo, "clean.md"), "# Demo\n");
    ok(git(["add", "clean.md"]));
    ok(git(["commit", "-q", "-m", "clean"]));
  });

  const refused = [
    ["a home directory path", "home.md", j("see /", "Users/", "x/notes\n"), /home-path/],
    ["CJK text outside the locale files", "text.md", j("label ", "\u770b\u677f", "\n"), /cjk-outside-locales/],
    ["a UUID", "id.md", j("agent ", "3934ae19-8389-4a8f-", "9b36-08c66eca8c34\n"), /uuid/],
    ["a private denylist term", "term.md", `about ${TERM.toLowerCase()}\n`, /private/],
    ["a real data file", "plans.json", "{}\n", /forbidden-path/],
  ];
  for (const [what, file, body, rule] of refused) {
    test(`a file with ${what} is refused`, () => {
      const result = tryCommit(file, body);
      assert.notEqual(result.status, 0, "commit should be refused");
      assert.match(result.stdout + result.stderr, rule);
    });
  }

  test("CJK text in a nested locales/zh-CN.json is committed", () => {
    const file = "packages/demo/shared/locales/zh-CN.json";
    mkdirSync(join(repo, dirname(file)), { recursive: true });
    writeFileSync(join(repo, file), j('{ "board.title": "', "\u770b\u677f", '" }\n'));
    ok(git(["add", file]));
    ok(git(["commit", "-q", "-m", "zh-CN locale"]));
  });

  test("CJK text in any other file under the same folder is refused", () => {
    mkdirSync(join(repo, "packages/demo/shared/locales"), { recursive: true });
    const result = tryCommit("packages/demo/shared/locales/en.json", j('{ "board.title": "', "\u770b\u677f", '" }\n'));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /cjk-outside-locales/);
  });

  test("a missing private denylist refuses every commit", () => {
    const result = tryCommit("fine.md", "fine\n", { FLEET_PRIVATE_DENYLIST: join(home, "missing.txt") });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private denylist not found/);
  });

  test("a personal identity is refused", () => {
    const result = tryCommit("fine.md", "fine\n", { GIT_COMMITTER_EMAIL: PERSONAL });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /committer: e-mail is not a placeholder/);
  });
});

describe("pre-push", () => {
  test("running the hook by hand runs npm run verify", () => {
    const result = spawnSync("sh", [".githooks/pre-push"], { cwd: repo, input: "", encoding: "utf8", env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /ANONYMOUS_VERIFIER_CALLED/);
    assert.match(result.stdout, /verify-ref: exact commit/);
  });

  test("a failing npm run verify refuses the push", () => {
    writeFileSync(join(repo, "verify-stub.mjs"), "console.error('ANONYMOUS_TARGET_FAILURE'); process.exit(1);\n");
    ok(git(["add", "verify-stub.mjs"])); ok(git(["commit", "-qm", "target fails"]));
    const result = git(["push", "-q", "origin", "HEAD:refs/heads/verify-fails"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /pre-push: refused/);
    assert.match(result.stdout + result.stderr, /ANONYMOUS_TARGET_FAILURE/);
    const pushed = spawnSync("git", ["-C", remote, "rev-parse", "--verify", "-q", "refs/heads/verify-fails"], { encoding: "utf8", env });
    assert.notEqual(pushed.status, 0, "nothing may reach the remote");
    ok(git(["reset", "-q", "--hard", "HEAD~1"]));
  });

  test("clean history is pushed", () => {
    ok(git(["push", "-q", "origin", "main"]));
  });

  test("a commit with a personal identity is not pushed", () => {
    writeFileSync(join(repo, "late.md"), "late\n");
    ok(git(["add", "late.md"]));
    unsafeCommit("late", { GIT_AUTHOR_EMAIL: PERSONAL });
    const result = git(["push", "-q", "origin", "main"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /author: e-mail is not a placeholder/);
    ok(git(["reset", "-q", "--hard", "HEAD~1"]));
  });

  test("a tree with personal data is not pushed, even if the working tree is clean", () => {
    writeFileSync(join(repo, "leak.md"), j("x ", "ABCD", "_0136\n"));
    ok(git(["add", "leak.md"]));
    unsafeCommit("leak");
    rmSync(join(repo, "leak.md"));
    const result = git(["push", "-q", "origin", "HEAD:refs/heads/topic"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /leak\.md:card-code/);
    const pushed = spawnSync("git", ["-C", remote, "rev-parse", "--verify", "-q", "refs/heads/topic"], { encoding: "utf8", env });
    assert.notEqual(pushed.status, 0, "the topic branch must not exist on the remote");
    ok(git(["reset", "-q", "--hard", "HEAD~1"]));
  });

  test("a deleted private blob in a previous tree still refuses publication", () => {
    const clean = ok(git(["rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(join(repo, "previous.md"), TERM); ok(git(["add", "previous.md"]));
    unsafeCommit("anonymous prior content");
    ok(git(["rm", "previous.md"])); ok(git(["commit", "-qm", "remove previous content"]));
    const result = hookAt(ok(git(["rev-parse", "HEAD"])).stdout.trim());
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /previous\.md:private/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TERM));
    ok(git(["reset", "-q", "--hard", clean]));
  });

  for (const extension of ["png", "mp4", "woff2"]) {
    test(`pre-push refuses deleted forbidden ${extension} evidence in a later outgoing ref`, () => {
      const clean = ok(git(["rev-parse", "HEAD"])).stdout.trim();
      const file = `docs/validation/hourly-quota/chart.${extension}`;
      let bad;
      try {
        mkdirSync(join(repo, dirname(file)), { recursive: true });
        writeFileSync(join(repo, file), Buffer.from([0, 1, 2, 3]));
        ok(git(["add", file])); unsafeCommit("anonymous evidence");
        ok(git(["rm", file])); ok(git(["commit", "-qm", "remove evidence"]));
        bad = ok(git(["rev-parse", "HEAD"])).stdout.trim();
      } finally {
        ok(git(["reset", "-q", "--hard", clean]));
      }
      const result = spawnSync("sh", [".githooks/pre-push"], { cwd: repo, encoding: "utf8", env,
        input: `refs/heads/clean ${clean} refs/heads/clean ${"0".repeat(40)}\nrefs/heads/evidence ${bad} refs/heads/evidence ${"0".repeat(40)}\n` });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok((result.stdout + result.stderr).includes(`${file}:forbidden-path`), result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`"tip":"${clean}"`));
      assert.match(result.stdout, new RegExp(`"tip":"${bad}"`));
      assert.equal((result.stdout.match(/ANONYMOUS_VERIFIER_CALLED/g) ?? []).length, 2, "both exact targets must still be verified");
    });
  }

  test("commit messages, annotated tag messages and private ref names remain checked", () => {
    const clean = ok(git(["rev-parse", "HEAD"])).stdout.trim();
    const bad = unsafeCommit(`message ${TERM}`);
    const message = hookAt(bad);
    assert.notEqual(message.status, 0);
    assert.match(message.stdout + message.stderr, /commit-metadata:private/);
    ok(git(["reset", "-q", "--hard", clean]));
    ok(git(["tag", "-a", "anonymous-tag", "-m", `tag ${TERM}`]));
    const tag = hookAt(ok(git(["rev-parse", "anonymous-tag"])).stdout.trim());
    assert.notEqual(tag.status, 0);
    assert.match(tag.stdout + tag.stderr, /tag-metadata:private/);
    const name = hookAt(clean, `refs/heads/${TERM}`);
    assert.notEqual(name.status, 0);
    assert.match(name.stdout + name.stderr, /refused ref name/);
    ok(git(["tag", "-d", "anonymous-tag"]));
  });

  test("pre-push reports refused ancestor metadata by type/count without locating its object", () => {
    const clean = ok(git(["rev-parse", "HEAD"])).stdout.trim();
    try {
      const ancestor = unsafeCommit(`message ${TERM}`);
      ok(git(["commit", "--allow-empty", "-qm", "clean later tip"]));
      const result = hookAt(ok(git(["rev-parse", "HEAD"])).stdout.trim());
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /commit-metadata:private \(1\)/);
      assert.ok(!result.stdout.includes(ancestor), "the finding's ancestor object must not be disclosed");
      assert.ok(!result.stdout.includes(TERM), "the refused message must not be disclosed");
      assert.match(result.stdout, /ANONYMOUS_VERIFIER_CALLED/);
    } finally {
      ok(git(["reset", "-q", "--hard", clean]));
    }
  });

  test("a non-HEAD target uses its own failing verifier while the current tree is healthy", () => {
    const clean = ok(git(["rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(join(repo, "verify-stub.mjs"), "console.error('NON_HEAD_TARGET_FAILURE'); process.exit(1);\n");
    ok(git(["add", "verify-stub.mjs"])); const bad = unsafeCommit("failing separate target");
    ok(git(["reset", "-q", "--hard", clean]));
    const result = hookAt(bad);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /NON_HEAD_TARGET_FAILURE/);
    assert.match(result.stdout, new RegExp(`verify-ref: exact commit ${bad}`));
    assert.doesNotMatch(result.stdout, /ANONYMOUS_VERIFIER_CALLED/);
  });

  test("every proposed ref is inspected, including a later ref with private history", () => {
    const clean = ok(git(["rev-parse", "HEAD"])).stdout.trim();
    const bad = unsafeCommit(`message ${TERM}`);
    ok(git(["reset", "-q", "--hard", clean]));
    const result = spawnSync("sh", [".githooks/pre-push"], { cwd: repo, encoding: "utf8", env,
      input: `refs/heads/clean ${clean} refs/heads/clean ${"0".repeat(40)}\nrefs/heads/later ${bad} refs/heads/later ${"0".repeat(40)}\n` });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, new RegExp(`"tip":"${clean}"`));
    assert.match(result.stdout, new RegExp(`"tip":"${bad}"`));
    assert.match(result.stdout, /commit-metadata:private/);
  });
});
