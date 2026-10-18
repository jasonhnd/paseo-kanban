// Tests for check-private.mjs. Every sample is assembled at run time, so this file itself scans clean.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileRules, occurrenceFingerprint, unusedPublicOccurrences, defaultListPath, masked, parseArgs, parseDenylist, scanFile } from "./check-private.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "check-private.mjs");
const compiled = compileRules(JSON.parse(readFileSync(join(here, "private-scan.rules.json"), "utf8")));
const j = (...parts) => parts.join("");
const rulesHit = (path, text, privateRules) => [...new Set(scanFile(path, text, compiled, privateRules).map((hit) => hit.rule))];

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("generic rules", () => {
  const cases = [
    ["home-path", j("const p = \"/", "Users/", "someone/x\";"), j("const p = \"/", "Users/", "example/x\";")],
    ["home-path", j("cd /", "home/", "someone/repo"), j("cd /", "home/", "user/repo")],
    ["windows-home", j("C:", "\\Users\\", "someone\\x"), "C:/tmp"],
    ["email", j("mail: someone", "@", "mail.test.org"), j("mail: noreply", "@", "example.invalid")],
    ["email", j("by a", "@", "gmail.com"), j("by 1+a", "@", "users.noreply.github.com")],
    ["uuid", j("agent ", "3934ae19-8389-4a8f-", "9b36-08c66eca8c34"), j("agent ", "00000000-0000-4000-8000-", "000000000001")],
    ["paseo-id", j("ws ", "wks_", "a538ef5d5cff4dac"), j("ws ", "wks_", "000000000000")],
    ["card-code", j("see ", "ABCD", "_0136"), j("see ", "DEMO", "_0001")],
    ["api-key", j("key ", "sk-", "abcdefghijklmnopqrstuvwxyz"), "key sk-short"],
    ["private-key", j("-----BEGIN ", "RSA PRIVATE KEY-----"), "-----BEGIN PUBLIC KEY-----"],
    ["jwt", j("eyJ", "hbGciOiJIUzI1", ".eyJzdWIiOiIxMjM0", ".SflKxwRJSMeKKF2QT4"), "eyJ.short"],
    ["bearer", j("Authorization: Bearer ", "abcdefghijklmnopqrstuvwxyz0123"), "Authorization: Bearer <token>"],
    ["url-with-token", j("https://x.test/cb?", "token=", "abcdef123456"), "https://x.test/cb?page=2"],
    ["cjk-outside-locales", j("label = \"", "\u770b\u677f", "\""), "label = \"board\""],
  ];
  for (const [rule, hit, clean] of cases) {
    test(`${rule}: hit and allowed form`, () => {
      assert.ok(rulesHit("src/a.ts", hit).includes(rule), `${rule} should hit`);
      assert.ok(!rulesHit("src/a.ts", clean).includes(rule), `${rule} should allow the clean sample`);
    });
  }

  // The same table in paseo-fleet, AFC and Kanban, whose rules files carry the same CJK rule.
  const cjkAllowed = [
    "locales/zh-CN.json",
    "shared/locales/zh-CN.json",
    "packages/x/locales/zh-CN.json",
    "packages/x/shared/locales/zh-CN.json",
    "cockpit/shared/locales/zh-CN.json",
    "shared/locales/zh-CN/tools.json",
    "packages/x/locales/zh-CN/tools.json",
    "packages/x/shared/locales/zh-CN/tools.json",
    "server/protocol/zh-CN/lead.md",
    "packages/x/server/protocol/zh-CN/lead.md",
    "docs/zh-CN/guide.md",
  ];
  const cjkRefused = [
    "shared/locales/en.json",
    "packages/x/locales/en.json",
    "packages/x/shared/locales/en.json",
    "cockpit/shared/locales/en.json",
    "packages/x/locales/en/tools.json",
    "packages/x/shared/locales/zh-CN.jsonc",
    "packages/x/shared/zh-CN.json",
    "packages/x/server/foo.ts",
    "packages/x/server/protocol/en/lead.md",
    "packages/x/shared/i18n.ts",
    "a/b/c/locales/zh-CN.json",
    "docs/guide.md",
    "README.md",
  ];
  for (const path of cjkAllowed) {
    test(`CJK is allowed in ${path}`, () => {
      assert.deepEqual(rulesHit(path, j("\u770b", "\u677f")), []);
    });
  }
  for (const path of cjkRefused) {
    test(`CJK is refused in ${path}`, () => {
      assert.ok(rulesHit(path, j("\u770b", "\u677f")).includes("cjk-outside-locales"));
    });
  }

  test("forbidden paths, with example and fixture exceptions", () => {
    assert.deepEqual(rulesHit("plans.json", "{}"), ["forbidden-path"]);
    assert.deepEqual(rulesHit("x/kanban.db", null), ["forbidden-path"]);
    assert.deepEqual(rulesHit("tmp/notes.md", "ok"), ["forbidden-path"]);
    assert.deepEqual(rulesHit(".env.local", "A=1"), ["forbidden-path"]);
    assert.deepEqual(rulesHit("examples/plans.example.json", "{}"), []);
    assert.deepEqual(rulesHit("node_modules/x/plans.json", "{}"), ["forbidden-path"]);
  });

  test("content ignores cannot exempt a forbidden path, including binary evidence", () => {
    for (const extension of ["png", "jpg", "jpeg", "gif", "webp", "mp4", "ico", "woff", "woff2"]) {
      const path = `docs/validation/hourly-quota/chart.${extension}`;
      assert.deepEqual(rulesHit(path, null), ["forbidden-path"], path);
      assert.deepEqual(rulesHit(path, "anonymous"), ["forbidden-path"], path);
    }
    assert.deepEqual(rulesHit("state/chart.png", null), ["forbidden-path"]);
  });

  test("content ignores still apply to otherwise permitted paths", () => {
    const text = j("see /", "home/", "somebody/private");
    assert.deepEqual(rulesHit("assets/chart.png", text), []);
    assert.deepEqual(rulesHit("node_modules/demo/index.js", text), []);
    assert.deepEqual(rulesHit("package-lock.json", text), []);
  });

  test("binary files are judged by path only", () => {
    assert.deepEqual(rulesHit("assets/icon.bin", null), []);
  });

  test("the hit is masked in the report", () => {
    const [hit] = scanFile("a.ts", j("x ", "ABCD", "_0136 y"), compiled);
    assert.equal(hit.snippet, "x *** y");
    assert.equal(masked("abc", 1, 1), "a***c");
  });
});

describe("private denylist", () => {
  const terms = parseDenylist(["# comment", "", j("Secret", "Project"), "/\\bAB_\\d{2}\\b/", "/\\bdemo\\b(?!:\\s*$)/i"].join("\n"));

  test("literal terms are case-insensitive, regex terms follow their flags", () => {
    assert.deepEqual(rulesHit("a.ts", j("path secret", "project here"), terms), ["private"]);
    assert.deepEqual(rulesHit("a.ts", j("code ", "AB_12"), terms), ["private"]);
    assert.deepEqual(rulesHit("a.ts", "code ab_12", terms), []);
  });

  test("a lookahead term can spare a YAML mapping key", () => {
    assert.deepEqual(rulesHit("ci.yml", "demo:", terms), []);
    assert.deepEqual(rulesHit("ci.yml", "run: demo build", terms), ["private"]);
  });

  test("file names are checked against the private terms too", () => {
    assert.deepEqual(rulesHit(j("notes/secret", "project.md"), "ok", terms), ["private"]);
    assert.deepEqual(rulesHit(j("assets/secret", "project.png"), null, terms), ["private"]); // images are ignored, their names are not
    assert.deepEqual(rulesHit(j("bin/secret", "project.bin"), null, terms), ["private"]);
  });

  test("the default list lives outside every repository", () => {
    assert.equal(defaultListPath({}, "/h"), join("/h", ".config", "paseo-fleet", "private-denylist.txt"));
    assert.equal(defaultListPath({ FLEET_PRIVATE_DENYLIST: "/x/list.txt" }, "/h"), "/x/list.txt");
  });

  test("arguments", () => {
    assert.deepEqual(parseArgs(["--all", "--list", "/l", "./a/", "b"]), { all: true, tree: null, history: null, privateList: true, list: "/l", quiet: false, prefixes: ["a/", "b"] });
    assert.equal(parseArgs(["--tree", "HEAD"]).tree, "HEAD");
    assert.throws(() => parseArgs(["--list"]));
    assert.throws(() => parseArgs(["--tree"]));
    assert.throws(() => parseArgs(["--all", "--tree", "HEAD"]));
    assert.throws(() => parseArgs(["--nope"]));
  });
});

describe("command line", () => {
  function repo(files) {
    const dir = mkdtempSync(join(tmpdir(), "check-private-test-"));
    temps.push(dir);
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "noreply@example.invalid"]);
    write(dir, files);
    return dir;
  }
  function write(dir, files) {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
  }
  const gitIn = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
  const cli = (cwd, args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });

  test("a missing private list fails with exit code 2", () => {
    const dir = repo({ "a.ts": "ok\n" });
    const out = cli(dir, ["--all", "--list", join(dir, "missing.txt")]);
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, /private denylist not found/);
  });

  test("hits exit 1 and are counted per rule; prefixes limit the scan", () => {
    const dir = repo({ "in/a.ts": j("x ", "ABCD", "_0136\n"), "out/b.ts": j("/", "Users/", "someone/\n"), "list.txt": "# empty\n" });
    const scoped = cli(dir, ["--all", "--list", join(dir, "list.txt"), "in/"]);
    assert.equal(scoped.status, 1);
    assert.match(scoped.stdout, /in\/a\.ts:1:card-code: x \*\*\*/);
    assert.match(scoped.stdout, /1 file\(s\) scanned, 1 hit\(s\) in 1 file\(s\): card-code 1/);
    const clean = cli(dir, ["--all", "--no-private-list", "list.txt"]);
    assert.equal(clean.status, 0, clean.stdout);
  });

  test("the private list applies on top of the generic rules", () => {
    const dir = repo({ "a.md": j("about ", "hidden", "name\n"), "list.txt": j("Hidden", "Name\n") });
    const out = cli(dir, ["--all", "--list", join(dir, "list.txt"), "a.md"]);
    assert.equal(out.status, 1);
    assert.match(out.stdout, /a\.md:1:private: about \*\*\*/);
    assert.doesNotMatch(out.stdout, /hiddenname/i);
  });

  test("staged mode reads the index, not the working tree", () => {
    const dir = repo({ "a.md": j("x ", "ABCD", "_0136\n") });
    gitIn(dir, "add", "a.md");
    write(dir, { "a.md": "clean now\n" }); // the commit would still carry the staged text
    const staged = cli(dir, ["--no-private-list"]);
    assert.equal(staged.status, 1, staged.stdout);
    assert.match(staged.stdout, /a\.md:1:card-code/);
    gitIn(dir, "add", "a.md");
    write(dir, { "a.md": j("x ", "ABCD", "_0136\n") }); // dirty working tree, clean index
    assert.equal(cli(dir, ["--no-private-list"]).status, 0);
  });

  test("--tree scans a commit's files, whatever the working tree holds", () => {
    const dir = repo({ "a.md": j("x ", "ABCD", "_0136\n") });
    gitIn(dir, "add", "a.md");
    gitIn(dir, "commit", "-q", "-m", "one");
    write(dir, { "a.md": "clean\n" });
    const out = cli(dir, ["--no-private-list", "--tree", "HEAD"]);
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /1 file\(s\) scanned, 1 hit/);
    assert.equal(cli(dir, ["--no-private-list", "--tree", "nope"]).status, 2);
  });
});


describe("reviewed public occurrences", () => {
  const path = "server/demo.ts";
  const line = 'const provider = "PublicVendor";';
  const match = [...line.matchAll(/PublicVendor/g)][0];
  const privateRules = parseDenylist("PublicVendor\nOtherPrivate");
  const rules = compileRules({ publicOccurrenceFingerprints: [occurrenceFingerprint(path, line, match, "PublicVendor")] });
  test("allows only the exact reviewed match in its original context", () => {
    assert.deepEqual(scanFile(path, line, rules, privateRules), []);
    assert.equal(scanFile("server/other.ts", line, rules, privateRules).length, 1);
    assert.equal(scanFile(path, line + " OtherPrivate", rules, privateRules).length, 2);
    assert.equal(scanFile(path, "// PublicVendor", rules, privateRules).length, 1);
    assert.equal(scanFile(path, line + "\nPublicVendor", rules, privateRules).length, 1);
  });
  test("never exempts generic rules or another denylist match", () => {
    const generic = compileRules({ publicOccurrenceFingerprints: [occurrenceFingerprint(path, line, match, "PublicVendor")], rules: [{id: "generic", pattern: "PublicVendor"}] });
    assert.equal(scanFile(path, line, generic, privateRules)[0].rule, "generic");
    assert.equal(scanFile(path, line, rules, parseDenylist("/PublicVendor/" )).length, 1);
    const overlapping = parseDenylist("PublicVendor\nVendor");
    assert.equal(scanFile(path, line, rules, overlapping).length, 1);
  });
  test("path exceptions are exact and independent from content exceptions", () => {
    const named = "integrations/PublicVendor/demo.py";
    const m = [...named.matchAll(/PublicVendor/g)][0];
    const scoped = compileRules({publicOccurrenceFingerprints: [occurrenceFingerprint(named, null, m, "PublicVendor")]});
    assert.deepEqual(scanFile(named, "", scoped, privateRules), []);
    assert.equal(scanFile(named, "PublicVendor", scoped, privateRules).length, 1);
    assert.equal(scanFile(named + ".bak", "", scoped, privateRules).length, 1);
  });
  test("stale fingerprints stay detectable until their exact occurrence is scanned", () => {
    const one = compileRules({publicOccurrenceFingerprints: [occurrenceFingerprint(path, line, match, "PublicVendor")]});
    assert.equal(unusedPublicOccurrences(one).length, 1);
    scanFile(path, line + " changed", one, privateRules);
    assert.equal(unusedPublicOccurrences(one).length, 1);
    scanFile(path, line, one, privateRules);
    assert.deepEqual(unusedPublicOccurrences(one), []);
  });
  test("malformed fingerprints fail closed", () => {
    assert.throws(() => compileRules({publicOccurrenceFingerprints: ["*"]}), /invalid public occurrence/);
  });
});
