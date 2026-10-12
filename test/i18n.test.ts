/// <reference types="node" />
// Translation catalogs, t(), language resolution and the config's language setting.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
  catalogKeys,
  getLanguage,
  interpolate,
  languageName,
  localeLanguage,
  resolveLanguage,
  setLanguage,
  t,
  translate,
  type MessageKey,
} from "../shared/i18n";
import { createConfigIfFresh, FRESH_LANGUAGE, LEGACY_LANGUAGE, loadConfig, parseLanguageSetting, setProjectAutoStart } from "../server/config";
import { closeDb } from "../server/db";
import { applyServerLanguage, languageSetting, serverLanguage, systemLocales } from "../server/language";

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff01-\uff5e]/;
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))].sort();
}

function catalog(language: "en" | "zh-CN"): Record<string, string> {
  return JSON.parse(readFileSync(new URL(`../shared/locales/${language}.json`, import.meta.url), "utf8")) as Record<string, string>;
}

const initial = getLanguage();
afterEach(() => setLanguage(initial));

describe("catalogs", () => {
  it("have the same keys in both languages", () => {
    assert.deepEqual([...catalogKeys("zh-CN")].sort(), [...catalogKeys("en")].sort());
  });

  it("use the same placeholders for every key in both languages", () => {
    const en = catalog("en");
    const zh = catalog("zh-CN");
    const mismatched = Object.keys(en).filter((key) => placeholders(en[key]).join() !== placeholders(zh[key] ?? "").join());
    assert.deepEqual(mismatched, []);
  });

  it("keep English free of Chinese text", () => {
    const en = catalog("en");
    const offenders = Object.entries(en).filter(([, value]) => CJK.test(value)).map(([key]) => key);
    assert.deepEqual(offenders, []);
  });

  it("name each language in its own catalog", () => {
    assert.equal(languageName("en"), "English");
    assert.equal(languageName("zh-CN"), "\u7b80\u4f53\u4e2d\u6587");
    assert.equal(catalog("en")["language.selfName"], "English");
    assert.equal(catalog("zh-CN")["language.selfName"], "\u7b80\u4f53\u4e2d\u6587");
  });

  it("are sorted, so diffs stay small", () => {
    for (const language of ["en", "zh-CN"] as const) {
      const keys = Object.keys(catalog(language));
      assert.deepEqual(keys, [...keys].sort(), `${language}.json is not sorted`);
    }
  });
});

describe("t()", () => {
  it("fills placeholders and leaves unknown ones alone", () => {
    assert.equal(interpolate("{a} and {b}", { a: 1 }), "1 and {b}");
    assert.equal(interpolate("no vars {a}"), "no vars {a}");
    assert.equal(interpolate("{count} cards in {project}", { count: 3, project: "demo" }), "3 cards in demo");
  });

  it("returns the current language and switches with setLanguage", () => {
    setLanguage("en");
    assert.equal(t("common.colon"), ": ");
    assert.equal(t("supervisor.view.headline", { title: "lead" }), "<leader>: lead");
    setLanguage("zh-CN");
    assert.equal(t("common.colon"), "\uff1a");
    assert.equal(t("supervisor.view.headline", { title: "lead" }), "<leader>\uff1alead");
  });

  it("translate() names the language explicitly and falls back to the key", () => {
    assert.equal(translate("en", "waitUser.hold", { decision: "k1005-091216-1" }), "Waiting for user: k1005-091216-1");
    assert.equal(translate("zh-CN", "waitUser.hold", { decision: "k1005-091216-1" }), "\u7b49\u7528\u6237\uff1ak1005-091216-1");
    assert.equal(translate("en", "no.such.key" as MessageKey), "no.such.key");
  });
});

describe("resolveLanguage()", () => {
  it("takes an explicit language as it is", () => {
    assert.equal(resolveLanguage("en", ["zh_CN.UTF-8"]), "en");
    assert.equal(resolveLanguage("zh-CN", ["en_US.UTF-8"]), "zh-CN");
  });

  it("follows the first system locale that names a shipped language", () => {
    assert.equal(resolveLanguage("system", ["zh_CN.UTF-8"]), "zh-CN");
    assert.equal(resolveLanguage("system", ["zh-Hans-CN"]), "zh-CN");
    assert.equal(resolveLanguage("system", ["en_GB.UTF-8", "zh_CN.UTF-8"]), "en");
    assert.equal(resolveLanguage("system", ["C", "zh_TW.UTF-8"]), "zh-CN");
  });

  it("falls back to English when nothing resolves", () => {
    assert.equal(resolveLanguage("system", []), "en");
    assert.equal(resolveLanguage("system", ["C", "POSIX", "ja_JP.UTF-8", undefined, ""]), "en");
    assert.equal(resolveLanguage("klingon", ["zh_CN.UTF-8"]), "en");
    assert.equal(resolveLanguage(undefined), "en");
  });

  it("reads locale names", () => {
    assert.equal(localeLanguage("zh"), "zh-CN");
    assert.equal(localeLanguage("zh_CN"), "zh-CN");
    assert.equal(localeLanguage("en"), "en");
    assert.equal(localeLanguage("english"), null);
    assert.equal(localeLanguage("zhx"), null);
    assert.equal(localeLanguage(null), null);
  });
});

describe("server language", () => {
  it("reads LC_ALL, then LC_MESSAGES, then LANG", () => {
    assert.deepEqual(systemLocales({ LANG: "en_US.UTF-8", LC_ALL: "zh_CN.UTF-8", LC_MESSAGES: "" }), ["zh_CN.UTF-8", "en_US.UTF-8"]);
    assert.equal(serverLanguage({ language: "system" }, { LANG: "en_US.UTF-8", LC_ALL: "zh_CN.UTF-8" }), "zh-CN");
    assert.equal(serverLanguage({ language: "system" }, { LANG: "en_US.UTF-8" }), "en");
    assert.equal(serverLanguage({ language: "system" }, {}), "en");
  });

  it("lets KANBAN_LANGUAGE override the config, and ignores a value that is not a language", () => {
    assert.equal(languageSetting({ language: "zh-CN" }, { KANBAN_LANGUAGE: "en" }), "en");
    assert.equal(languageSetting({ language: "en" }, { KANBAN_LANGUAGE: "system" }), "system");
    assert.equal(languageSetting({ language: "en" }, { KANBAN_LANGUAGE: "fr" }), "en");
  });

  it("keeps an object without a language on the legacy language", () => {
    assert.equal(languageSetting({}, {}), LEGACY_LANGUAGE);
    assert.equal(serverLanguage({}, { LANG: "en_US.UTF-8" }), "zh-CN");
  });

  it("applyServerLanguage sets the process language", () => {
    assert.equal(applyServerLanguage({ LANG: "en_US.UTF-8" }, { language: "system" }), "en");
    assert.equal(getLanguage(), "en");
    assert.equal(applyServerLanguage({}, { language: "zh-CN" }), "zh-CN");
    assert.equal(getLanguage(), "zh-CN");
  });
});

describe("config language", () => {
  const dirs: string[] = [];
  const saved = process.env.KANBAN_DATA_DIR;
  function freshDir(): string {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "i18n-config-"));
    dirs.push(dir);
    process.env.KANBAN_DATA_DIR = dir;
    return dir;
  }
  after(() => {
    closeDb();
    if (saved === undefined) delete process.env.KANBAN_DATA_DIR;
    else process.env.KANBAN_DATA_DIR = saved;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("parses the field: missing is the legacy language, junk is English", () => {
    assert.equal(parseLanguageSetting(undefined), "zh-CN");
    assert.equal(parseLanguageSetting("en"), "en");
    assert.equal(parseLanguageSetting("system"), "system");
    assert.equal(parseLanguageSetting("zh-CN"), "zh-CN");
    assert.equal(parseLanguageSetting("de"), "en");
    assert.equal(parseLanguageSetting(42), "en");
  });

  it("keeps an existing config without a language field in Chinese", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "kanban.config.json"), `${JSON.stringify({ autoStart: {}, supervisors: {} })}\n`);
    assert.equal(loadConfig().language, "zh-CN");
    assert.equal(serverLanguage(loadConfig(), { LANG: "en_US.UTF-8" }), "zh-CN");
  });

  it("reads an explicit language from the file", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "kanban.config.json"), `${JSON.stringify({ language: "en" })}\n`);
    assert.equal(loadConfig().language, "en");
  });

  it("gives a fresh installation the system language, in memory and in its first file", () => {
    const dir = freshDir();
    assert.equal(loadConfig().language, FRESH_LANGUAGE);
    assert.equal(FRESH_LANGUAGE, "system");
    assert.equal(createConfigIfFresh(() => ({ projects: {} })), true);
    const written = JSON.parse(readFileSync(join(dir, "kanban.config.json"), "utf8")) as { language?: string };
    assert.equal(written.language, "system");
    assert.equal(loadConfig().language, "system");
  });

  it("records the system language when a fresh installation's first write is an update", () => {
    const dir = freshDir();
    setProjectAutoStart("demo", true);
    const written = JSON.parse(readFileSync(join(dir, "kanban.config.json"), "utf8")) as { language?: string };
    assert.equal(written.language, "system");
  });
});
