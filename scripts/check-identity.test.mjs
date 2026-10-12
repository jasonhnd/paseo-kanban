// Tests for check-identity.mjs. Personal-looking samples are assembled at run time so this file scans clean.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDenylist } from "./check-private.mjs";
import { ALLOWED_EMAIL, judge, parseArgs, parseIdent } from "./check-identity.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-identity.mjs");
const j = (...parts) => parts.join("");
const PERSONAL = j("someone", "@", "mail.test.org");
const PLACEHOLDER = "noreply@example.invalid";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("rules", () => {
  test("allowed e-mail addresses", () => {
    for (const ok of [PLACEHOLDER, j("123+demo", "@users.noreply.github.com"), j("demo-bot[bot]", "@users.noreply.github.com"), j("noreply", "@github.com")]) {
      assert.ok(ALLOWED_EMAIL.test(ok), ok);
    }
    for (const bad of [PERSONAL, j("noreply", "@example.com"), "", j("a b", "@users.noreply.github.com")]) assert.ok(!ALLOWED_EMAIL.test(bad), bad);
  });

  test("names and e-mails are checked against the private terms", () => {
    const terms = parseDenylist(j("/\\bSecret", "Name\\b/\n"));
    assert.deepEqual(judge({ where: "author", name: "paseo-fleet contributors", email: PLACEHOLDER }, terms), []);
    assert.equal(judge({ where: "author", name: j("Secret", "Name"), email: PLACEHOLDER }, terms).length, 1);
    assert.equal(judge({ where: "author", name: "x", email: PERSONAL }, terms).length, 1);
    const listed = parseDenylist(j("1+secret", "name\n"));
    assert.match(judge({ where: "c", name: "x", email: j("1+secret", "name@users.noreply.github.com") }, listed)[0], /e-mail contains a term/);
  });

  test("parseIdent and arguments", () => {
    assert.deepEqual(parseIdent(`demo user <${PLACEHOLDER}> 1700000000 +0000`), { name: "demo user", email: PLACEHOLDER });
    assert.throws(() => parseIdent("garbage"));
    assert.equal(parseArgs(["--range", "a..b"]).range, "a..b");
    assert.equal(parseArgs(["--history", "--no-private-list"]).privateList, false);
    assert.throws(() => parseArgs(["--range"]));
    assert.throws(() => parseArgs(["--range", "a", "--history"]));
    assert.throws(() => parseArgs(["extra"]));
  });
});

describe("command line", () => {
  // A clean environment: no global or system git config, so only what the test sets applies.
  const empty = mkdtempSync(join(tmpdir(), "check-identity-home-"));
  temps.push(empty);
  const baseEnv = { ...process.env, HOME: empty, XDG_CONFIG_HOME: empty, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(empty, "none") };
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete baseEnv[key];
  const git = (dir, args, env = {}) => execFileSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", env: { ...baseEnv, ...env } });
  const cli = (dir, args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env: { ...baseEnv, FLEET_PRIVATE_DENYLIST: join(empty, "no-list.txt"), ...env } });

  function repo(name, email) {
    const dir = mkdtempSync(join(tmpdir(), "check-identity-test-"));
    temps.push(dir);
    git(dir, ["init", "-q"]);
    if (name) git(dir, ["config", "user.name", name]);
    if (email) git(dir, ["config", "user.email", email]);
    return dir;
  }
  function commit(dir, file, env = {}) {
    writeFileSync(join(dir, file), `${file}\n`);
    git(dir, ["add", file]);
    git(dir, ["commit", "-q", "-m", file], env);
  }

  test("the placeholder identity passes; an empty history passes", () => {
    const dir = repo("paseo-fleet contributors", PLACEHOLDER);
    const out = cli(dir, []);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /next commit, 2 identit/);
    assert.equal(cli(dir, ["--history"]).status, 0);
  });

  test("a personal e-mail is refused, also when it comes from the environment", () => {
    const personal = repo("someone", PERSONAL);
    const out = cli(personal, []);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /author: e-mail is not a placeholder/);
    const viaEnv = cli(repo("paseo-fleet contributors", PLACEHOLDER), [], { GIT_AUTHOR_EMAIL: PERSONAL });
    assert.equal(viaEnv.status, 1);
    assert.match(viaEnv.stderr, /author: e-mail/);
    assert.doesNotMatch(viaEnv.stderr, /committer/);
  });

  test("a repository without its own identity is refused even when git can find one", () => {
    const dir = repo(null, null);
    const out = cli(dir, [], { GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: PLACEHOLDER, GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: PLACEHOLDER });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /git config --local user\.name is not set/);
    assert.match(out.stderr, /git config --local user\.email is not set/);
  });

  test("--history and --range check every commit's author and committer", () => {
    const dir = repo("paseo-fleet contributors", PLACEHOLDER);
    commit(dir, "a.txt");
    const base = git(dir, ["rev-parse", "HEAD"]).trim();
    commit(dir, "b.txt", { GIT_COMMITTER_EMAIL: PERSONAL });
    const history = cli(dir, ["--history"]);
    assert.equal(history.status, 1);
    assert.match(history.stdout, /2 commit\(s\), 4 identit/);
    assert.match(history.stderr, /[0-9a-f]{12} committer: e-mail/);
    assert.equal(cli(dir, ["--range", `${base}..HEAD`]).status, 1);
    assert.equal(cli(dir, ["--range", base]).status, 0);
    assert.equal(cli(dir, ["--range", "nope..HEAD"]).status, 2);
  });

  test("the private denylist, when present, also covers names", () => {
    const dir = repo(j("Secret", "Name"), PLACEHOLDER);
    const list = join(dir, "..", `${dir.split("/").pop()}-list.txt`);
    writeFileSync(list, j("secret", "name\n"));
    temps.push(list);
    const out = cli(dir, [], { FLEET_PRIVATE_DENYLIST: list });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /name contains a term from the private denylist/);
    assert.equal(cli(dir, ["--no-private-list"], { FLEET_PRIVATE_DENYLIST: list }).status, 0);
    assert.equal(cli(dir, ["--list", join(dir, "missing.txt")]).status, 2);
  });
});
