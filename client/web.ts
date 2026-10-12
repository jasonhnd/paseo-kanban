import { Platform } from "react-native";

// The only client module allowed to touch browser globals. The plugin typechecks without the DOM
// library, so declare only what this module uses; every export is gated on Platform.OS === "web".
declare const document: {
  visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

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
