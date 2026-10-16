import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assertReminderGuard } from "../server/wait-user";

test("current and legacy automatic reminder spellings retain the decision guard", () => {
  for (const title of ["Kanban automatic reminder", "\u770b\u677f\u81ea\u52a8\u63d0\u9192", "AFC automatic reminder", "AFC \u81ea\u52a8\u63d0\u9192"]) {
    assert.throws(() => assertReminderGuard({ isSchedule: false, title, brief: "", decision: null }));
    assert.throws(() => assertReminderGuard({ isSchedule: false, title: "", brief: title, decision: null }));
  }
  assert.doesNotThrow(() => assertReminderGuard({ isSchedule: false, title: "Ordinary card", brief: "", decision: null }));
});

test("display catalogs and leader command help use current branding", () => {
  for (const locale of ["en", "zh-CN"]) {
    for (const suffix of [".json", "/fleet.json", "/tools.json"]) {
      const messages = JSON.parse(readFileSync(new URL(`../shared/locales/${locale}${suffix}`, import.meta.url), "utf8"));
      for (const [key, value] of Object.entries(messages)) assert.doesNotMatch(String(value), /AFC/, key);
    }
    const help = readFileSync(new URL(`../server/protocol/${locale}/cli-help.md`, import.meta.url), "utf8");
    assert.doesNotMatch(help, /AFC/);
  }
});
