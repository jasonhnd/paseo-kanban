/// <reference types="node" />
import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, describe, it } from "node:test";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { onPageVisible } = await import("../client/web");
const { Platform } = (await import("react-native")) as unknown as { Platform: { OS: string } };

type Listener = () => void;
function fakeDocument(state: string) {
  const listeners = new Set<Listener>();
  return {
    visibilityState: state,
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    emit() {
      for (const listener of listeners) listener();
    },
    listeners,
  };
}
const holder = globalThis as { document?: unknown };

describe("client/web onPageVisible", () => {
  afterEach(() => {
    delete holder.document;
    Platform.OS = "web";
  });

  it("fires only when the web page turns visible, and stops after unsubscribe", () => {
    const page = fakeDocument("hidden");
    holder.document = page;
    let calls = 0;
    const stop = onPageVisible(() => calls++);
    page.emit();
    assert.equal(calls, 0);
    page.visibilityState = "visible";
    page.emit();
    assert.equal(calls, 1);
    stop();
    assert.equal(page.listeners.size, 0);
    page.emit();
    assert.equal(calls, 1);
  });

  it("is a no-op without a document or off the web", () => {
    assert.doesNotThrow(() => onPageVisible(() => assert.fail("no page to watch"))());
    const page = fakeDocument("visible");
    holder.document = page;
    Platform.OS = "ios";
    const stop = onPageVisible(() => assert.fail("native uses AppState"));
    assert.equal(page.listeners.size, 0);
    stop();
  });
});
