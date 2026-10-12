import { strict as assert } from "node:assert";
import { test } from "node:test";
import { register } from "node:module";
register(new URL("../../../test/rn-hooks.mjs", import.meta.url));
const { adoptSettingsLanguage, rememberedLanguage, SETTINGS_LANGUAGE_KEY } = await import("../../../client/fleet/settings-language");
const { Platform } = (await import("react-native")) as unknown as { Platform: { OS: string } };
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

test("native settings use the resolved language without touching the browser getter", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let reads = 0;
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { reads++; throw new Error("native getter"); } });
    for (const platform of ["ios", "android"]) {
      Platform.OS = platform;
      assert.equal(rememberedLanguage(), null);
      for (const value of ["zh-CN", "en"] as const) { adoptSettingsLanguage(value); assert.equal(language(), value); }
    }
    assert.equal(reads, 0);
  } finally {
    Platform.OS = "web";
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("throwing web storage methods do not stop resolved settings language updates", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem() { throw new Error("blocked read"); }, setItem() { throw new Error("quota exceeded"); },
    } });
    assert.equal(rememberedLanguage(), null);
    adoptSettingsLanguage("zh-CN"); assert.equal(language(), "zh-CN");
  } finally {
    adoptSettingsLanguage("en");
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
