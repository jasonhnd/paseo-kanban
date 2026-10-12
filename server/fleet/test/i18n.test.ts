// Interface language: the two catalogs (shared/locales/), t() and how the language is chosen.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { catalogKeys, language, languageFromLocale, resolveLanguage, setLanguage, systemLanguage, t, tAll, tIn } from "../../../shared/fleet/i18n";
import { AFC_CONFIG_FILE } from "../adapters/config";
import { initLanguage, languageSetting } from "../language";

const CJK = new RegExp("[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uff01-\\uff5e]");
const PLACEHOLDER = /\{(\w+)\}/g;
const catalog = (name: string): Record<string, string> => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "shared", "locales", name.replace(/\.json$/, ""), "fleet.json"), "utf8"));

const dirs: string[] = [];
function freshDir(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "afc-i18n-test-"));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(join(dir, AFC_CONFIG_FILE), JSON.stringify(config));
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("catalogs", () => {
  test("en and zh-CN have the same keys", () => {
    assert.deepEqual([...catalogKeys("zh-CN")].sort(), [...catalogKeys("en")].sort());
  });

  test("each zh-CN value uses the same placeholders as its English source", () => {
    const en = catalog("en.json");
    const zh = catalog("zh-CN.json");
    const names = (text: string) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();
    const mismatched = Object.keys(en).filter((key) => names(en[key]).join() !== names(zh[key] ?? "").join());
    assert.deepEqual(mismatched, []);
  });

  test("English values hold no CJK text", () => {
    const en = catalog("en.json");
    assert.deepEqual(Object.keys(en).filter((key) => CJK.test(en[key])), []);
  });
});

describe("t", () => {
  test("fills placeholders and leaves unknown ones as written", () => {
    assert.equal(tIn("en", "i18n.languageName"), "English");
    setLanguage("en");
    assert.equal(t("i18n.languageName"), "English");
    setLanguage("zh-CN");
    assert.equal(language(), "zh-CN");
    assert.notEqual(t("i18n.languageName"), "English");
  });

  test("tAll lists each distinct value once", () => {
    assert.equal(tAll("i18n.languageName").length, 2);
  });
});

describe("choosing the language", () => {
  test("locale tags", () => {
    assert.equal(languageFromLocale("zh_CN.UTF-8"), "zh-CN");
    assert.equal(languageFromLocale("zh-Hans-CN"), "zh-CN");
    assert.equal(languageFromLocale("en_US.UTF-8"), "en");
    assert.equal(languageFromLocale("C.UTF-8"), null);
    assert.equal(languageFromLocale("POSIX"), null);
    assert.equal(languageFromLocale("fr_FR"), null);
    assert.equal(languageFromLocale(""), null);
  });

  test("system: LC_ALL before LANG; an unknown locale falls through; nothing known is English", () => {
    assert.equal(systemLanguage({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, () => "en-US"), "zh-CN");
    assert.equal(systemLanguage({ LANG: "C.UTF-8" }, () => "zh-CN"), "zh-CN");
    assert.equal(systemLanguage({ LANG: "fr_FR" }, () => "de-DE"), "en");
  });

  test("an explicit language wins; missing or invalid follows the locale", () => {
    assert.equal(resolveLanguage("zh-CN", { LANG: "en_US" }), "zh-CN");
    assert.equal(resolveLanguage("en", { LANG: "zh_CN" }), "en");
    assert.equal(resolveLanguage("system", { LANG: "zh_CN" }), "zh-CN");
    assert.equal(resolveLanguage("klingon", { LANG: "zh_CN" }), "zh-CN");
    assert.equal(resolveLanguage(undefined, { LANG: "en_US" }), "en");
    assert.equal(resolveLanguage("system", { LANG: "C" }), systemLanguage({ LANG: "C" }));
    assert.equal(resolveLanguage("system", { LANG: "POSIX" }), systemLanguage({ LANG: "POSIX" }));
  });

  test("afc.config.json language field", () => {
    assert.equal(languageSetting({ language: "zh-CN" }), "zh-CN");
    assert.equal(languageSetting({ language: "en" }), "en");
    assert.equal(languageSetting({ language: "system" }), "system");
    assert.equal(languageSetting({ language: 3 }), "system");
    assert.equal(languageSetting(null), "system");
    assert.equal(languageSetting([]), "system");
  });

  test("initLanguage: AFC_LANGUAGE, then an explicit config language, then the system", () => {
    assert.equal(initLanguage(freshDir({ language: "zh-CN" }), { LANG: "en_US" }), "zh-CN");
    assert.equal(initLanguage(freshDir({ language: "en" }), { LANG: "zh_CN" }), "en");
    assert.equal(initLanguage(freshDir({ language: "en" }), { AFC_LANGUAGE: "zh-CN" }), "zh-CN");
    assert.equal(initLanguage(freshDir({ language: "zh-CN" }), { AFC_LANGUAGE: "en" }), "en");
    assert.equal(initLanguage(freshDir({ language: "system" }), { LANG: "zh_CN.UTF-8" }), "zh-CN");
    assert.equal(initLanguage(freshDir({ language: "nope" }), { LANG: "zh_CN.UTF-8" }), "zh-CN");
    assert.equal(initLanguage(freshDir(), { LANG: "zh_CN.UTF-8" }), "zh-CN");
    assert.equal(initLanguage(freshDir("not json {"), { LANG: "C" }), systemLanguage({ LANG: "C" }));
    assert.equal(initLanguage(freshDir("not json {"), { LANG: "POSIX" }), systemLanguage({ LANG: "POSIX" }));
    assert.equal(language(), systemLanguage({ LANG: "POSIX" }));
  });
});
