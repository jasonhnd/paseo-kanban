import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRules, occurrenceFingerprint, scanFile, unusedPublicOccurrences, observeReviewedOccurrences } from "../server/privacy-scanner.mjs";
import { parseDenylist } from "../shared/privacy-denylist.mjs";

const path = "fixture.txt";
const line = 'const example = "PublicVendor";';
const match = [...line.matchAll(/PublicVendor/g)][0];
const approval = (rule = "private") => ({ path, rule, index: match.index, length: match[0].length,
  fingerprint: occurrenceFingerprint(path, line, match, rule) });
const config = (rule = "private") => ({ reviewedOccurrences: [approval(rule)] });

test("reviewed occurrences bind the path, complete line, exact span and rule", () => {
  const privateRules = parseDenylist("PublicVendor");
  assert.deepEqual(scanFile(path, line, compileRules(config()), privateRules), []);
  for (const [file, text] of [["other.txt", line], [path, line + " // changed"], [path, " " + line], [path, line.replace("PublicVendor", "publicvendor")]]) {
    assert.equal(scanFile(file, text, compileRules(config()), privateRules).length, 1);
  }
  assert.equal(scanFile(path, line, compileRules(config("email")), privateRules).length, 1);
  const otherPrivateRule = parseDenylist("const");
  assert.equal(scanFile(path, line, compileRules(config()), otherPrivateRule).length, 1);
  assert.equal(scanFile(path, line, compileRules(config()), parseDenylist("/PublicVendor|const/g")).length, 1);
});

test("generic rules share the same exact approvals and never exempt other rules", () => {
  const rules = [{ id: "fixture-rule", pattern: "PublicVendor" }, { id: "second-rule", pattern: "PublicVendor" }];
  const compiled = compileRules({ ...config("fixture-rule"), rules });
  assert.deepEqual(scanFile(path, line, compiled).map(hit => hit.rule), ["second-rule"]);
  assert.equal(unusedPublicOccurrences(compiled).length, 0);
});

test("freshness observes exact approvals even for ignored content without weakening actual scans", () => {
  const compiled = compileRules({ ...config(), ignorePaths: ["^fixture\\.txt$"] });
  assert.equal(unusedPublicOccurrences(compiled).length, 1);
  observeReviewedOccurrences(path, line + " changed", compiled);
  assert.equal(unusedPublicOccurrences(compiled).length, 1);
  observeReviewedOccurrences(path, line, compiled);
  assert.equal(unusedPublicOccurrences(compiled).length, 0);
  assert.equal(scanFile(path, line + " changed", { ...compiled, ignore: [] }, parseDenylist("PublicVendor")).length, 1);
});

test("path approvals are exact and cannot approve content or another directory", () => {
  const directory = "integrations/PublicVendor";
  const pathMatch = [...directory.matchAll(/PublicVendor/g)][0];
  const compiled = compileRules({ reviewedOccurrences: [{ path: directory, rule: "private", index: pathMatch.index,
    length: pathMatch[0].length, fingerprint: occurrenceFingerprint(directory, null, pathMatch, "private") }] });
  const denylist = parseDenylist("PublicVendor");
  assert.deepEqual(scanFile(directory, null, compiled, denylist), []);
  assert.ok(scanFile(directory + "-other", null, compiled, denylist).length);
  assert.ok(scanFile(path, "PublicVendor", compiled, denylist).length);
});

test("malformed exact approvals fail closed", () => {
  for (const patch of [{ index: -1 }, { length: 0 }, { fingerprint: "bad" }, { path: "../fixture.txt" }, { rule: "" }]) {
    assert.throws(() => compileRules({ reviewedOccurrences: [{ ...approval(), ...patch }] }));
  }
});
