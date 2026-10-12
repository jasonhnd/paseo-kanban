import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { onPageVisible } from "./web";

/** How often the overview and attention tabs re-read the board while the panel is open. */
export const BOARD_REFRESH_MS = 30_000;
/** How often the decisions tab re-reads decisions.json. */
export const DECISIONS_REFRESH_MS = 60_000;

/**
 * Calls `onVisible` whenever the panel could have come back into view: the app returns to the
 * foreground (native) or the page becomes visible again (web). The host keeps a panel mounted while
 * it is hidden, so mounting alone is not enough to catch a reopen.
 */
export function useRefreshOnVisible(onVisible: () => void): void {
  const latest = useRef(onVisible);
  latest.current = onVisible;
  useEffect(() => {
    const fire = () => latest.current();
    const app = AppState?.addEventListener?.("change", (state: string) => {
      if (state === "active") fire();
    });
    const stopPage = onPageVisible(fire);
    return () => {
      app?.remove?.();
      stopPage();
    };
  }, []);
}

/** hh:mm:ss in local time, for the "Updated" label. */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
