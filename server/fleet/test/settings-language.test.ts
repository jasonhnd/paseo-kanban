import { strict as assert } from "node:assert";
import { test } from "node:test";
import { adoptSettingsLanguage, rememberedLanguage, SETTINGS_LANGUAGE_KEY } from "../../../client/fleet/settings-language";
import { language } from "../../../shared/fleet/i18n";

test("resolved languages persist for the next settings title registration", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
    assert.equal(rememberedLanguage(), null);
    adoptSettingsLanguage("zh-CN");
    assert.equal(stored.get(SETTINGS_LANGUAGE_KEY), "zh-CN");
    assert.equal(rememberedLanguage(), "zh-CN");
    adoptSettingsLanguage("en");
    assert.equal(rememberedLanguage(), "en");
    stored.set(SETTINGS_LANGUAGE_KEY, "invalid");
    assert.equal(rememberedLanguage(), null);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
test("unavailable client storage does not prevent language updates", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Demo storage disabled"); } });
    assert.equal(rememberedLanguage(), null);
    adoptSettingsLanguage("en");
    assert.equal(language(), "en");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
