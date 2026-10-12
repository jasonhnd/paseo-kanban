import { Platform } from "react-native";

// The only client module allowed to touch browser globals. The plugin typechecks without the DOM
// library, so declare only what this module uses; every export is gated on Platform.OS === "web".
declare const document: {
  visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

type WebStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** Best-effort browser persistence. Native must not even read the storage getter. */
export function readWebStorage(key: string): string | null {
  if (Platform.OS !== "web") return null;
  try {
    const storage = (globalThis as { localStorage?: WebStorage }).localStorage;
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** A blocked getter or a failed write must not prevent an in-memory language update. */
export function writeWebStorage(key: string, value: string): void {
  if (Platform.OS !== "web") return;
  try {
    (globalThis as { localStorage?: WebStorage }).localStorage?.setItem(key, value);
  } catch {
    // Storage can be disabled or full; the server setting remains the source of truth.
  }
}

/**
 * Calls `listener` each time the browser page becomes visible again. No-op on native, where the
 * caller listens to AppState instead. Returns the unsubscribe function.
 */
export function onPageVisible(listener: () => void): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};
  const onChange = () => {
    if (document.visibilityState === "visible") listener();
  };
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
