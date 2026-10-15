/// <reference types="node" />
// Pure parsing for cursor-usage.ts: the text of cursor-agent's `/usage` screen, and the stored cursor-usage.json.
// Nothing here starts a process or touches a file.
import type { CursorUsageReading } from "./cursor-usage";
import { flattenAnsi, stripAnsi } from "./screen-read";
import { tAll } from "../../shared/fleet/i18n";

/** One row from the `/usage` screen. Dollars are the On-Demand amount, not a percent. */
export interface CursorScreenWindow {
  /** Label as printed, such as "Auto", "API", "On-Demand", or "Agent sandbox". */
  label: string;
  usedPct: number | null;
  onDemandUsd: number | null;
  onDemandLimitUsd: number | null;
  /** Set when the official API gave this row its own reset. A screen row leaves it unset. */
  resetsAt?: string | null;
}


/** What the `/usage` screen gives: the same fields as a reading, minus the read's own bookkeeping. */
export interface ParsedCursorUsage {
  includedPct: number | null;
  autoPct: number | null;
  apiPct: number | null;
  onDemandUsd: number | null;
  onDemandLimitUsd: number | null;
  resetsAt: string | null;
  windows: CursorScreenWindow[];
  loggedOut: boolean;
}

const ROW_LABEL = /^(included|auto|api|on-demand|on demand|agent sandbox|grok)$/i;

function headerish(line: string): boolean {
  return /^(usage\b|resets\b|category$|current$|monthly\b|personal spend)/i.test(line.trim());
}

function moneyOf(text: string): { usd: number | null; limit: number | null } {
  const m = /\$(\d+(?:\.\d+)?)\s*\/\s*\$(\d+(?:\.\d+)?)/.exec(text);
  return m ? { usd: Number(m[1]), limit: Number(m[2]) } : { usd: null, limit: null };
}

function pctOf(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function pushWindow(rows: CursorScreenWindow[], label: string, rest: string): void {
  const name = label.trim().replace(/\s+/g, " ");
  if (!name || headerish(name)) return;
  const usedPct = pctOf(rest);
  const money = moneyOf(rest);
  if (usedPct === null && money.usd === null) return;
  rows.push({ label: name, usedPct, onDemandUsd: money.usd, onDemandLimitUsd: money.limit });
}

/**
 * Every quota row on the `/usage` screen.
 * Accepts the wide layout (`  Auto    40% used`) and the stacked layout (label, then `40% used` on the next line).
 * A bare "Resets Oct 12" is not turned into a timestamp.
 */
export function parseCursorScreenWindows(raw: string): CursorScreenWindow[] {
  const lines = stripAnsi(raw).split("\n");
  const rows: CursorScreenWindow[] = [];
  let pending: string | null = null;
  const same = /^\s*(included|auto|api|on-demand|on demand|agent sandbox|grok)\b\s*(?::\s*|\s+)(.*)$/i;
  const extra = /^\s*([A-Za-z][A-Za-z0-9+._-]{0,24}(?: [A-Za-z][A-Za-z0-9+._-]{0,24})?)\s{2,}(.*(?:%|\$).*)$/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^[█░—\-\s]+$/.test(trimmed)) continue;
    const inline = same.exec(line);
    if (inline && /%|\$/.test(inline[2])) {
      pushWindow(rows, inline[1], inline[2]);
      pending = null;
      continue;
    }
    const more = extra.exec(line);
    if (more && !headerish(more[1]) && !ROW_LABEL.test(more[1].trim())) {
      pushWindow(rows, more[1], more[2]);
      pending = null;
      continue;
    }
    if (ROW_LABEL.test(trimmed)) {
      pending = trimmed;
      continue;
    }
    if (pending && /%|\$/.test(trimmed)) {
      pushWindow(rows, pending, trimmed);
      pending = null;
    }
  }
  return rows;
}

function windowPct(rows: CursorScreenWindow[], label: string): number | null {
  const row = rows.find((r) => r.label.toLowerCase() === label.toLowerCase());
  return row?.usedPct ?? null;
}

/** Parse the `/usage` screen. Auto is required; the other fields may be missing. */
export function parseCursorUsageScreen(raw: string): ParsedCursorUsage | null {
  const windows = parseCursorScreenWindows(raw);
  const autoPct = windowPct(windows, "Auto");
  if (autoPct === null) return null;
  const demand = windows.find((r) => /on-?demand/i.test(r.label));
  return {
    includedPct: windowPct(windows, "Included"),
    autoPct,
    apiPct: windowPct(windows, "API"),
    onDemandUsd: demand?.onDemandUsd ?? null,
    onDemandLimitUsd: demand?.onDemandLimitUsd ?? null,
    resetsAt: null,
    windows,
    loggedOut: false,
  };
}

/** Login splash or a status line. Does not look at account names. */
export function textSaysLoggedOut(raw: string): boolean {
  if (/press any key to log in|signing in|not logged in/i.test(raw)) return true;
  // Older readings stored this sentence of our own; match it in every language.
  const lower = raw.toLowerCase();
  return tAll("screen.match.loginScreenStuck").some((text) => lower.includes(text.toLowerCase()));
}

/** Words that mean a login flow is on screen. "Logged in" does not match. */
const LOGIN_WORD_RE = /sign(?:ing)?\s+in|\blog[\s-]?in\b|\blogin\b|\bbrowser\b|\bqr\b/i;
const READY_RE = /Plan, search, build anything|(?:^|\n)\s*[›>→]\s*$/m;

/** True when this frame is asking for a login. Checked before any key is sent. */
export function frameSaysLogin(raw: string): boolean {
  return LOGIN_WORD_RE.test(flattenAnsi(raw)) || LOGIN_WORD_RE.test(stripAnsi(raw));
}

/**
 * What the captured screen is asking us to do. Login is never answered.
 * A login word wins over a composer in the same frame: the session must end with no keys.
 */
export function interpretScreen(raw: string): "login" | "usage" | "ready" | "wait" {
  const text = stripAnsi(raw);
  const flat = flattenAnsi(raw);
  if (frameSaysLogin(raw)) return "login";
  if (parseCursorUsageScreen(text)) return "usage";
  if (READY_RE.test(flat) || READY_RE.test(text)) return "ready";
  return "wait";
}

/**
 * A stored cursor-usage.json as a reading. Null when it is not an object with `ok` and `readAt`.
 * Files written before `windows` existed are rebuilt from the fields they did store.
 */
export function normalizeStoredReading(parsed: unknown): CursorUsageReading | null {
  const raw = parsed as Partial<CursorUsageReading> | null;
  if (!raw || typeof raw.ok !== "boolean" || typeof raw.readAt !== "string") return null;
  const error = typeof raw.error === "string" ? raw.error : null;
  const windows = screenWindows(raw.windows);
  return {
    ...(raw.lastKnown && typeof raw.lastKnown.autoPct === "number" && Number.isFinite(raw.lastKnown.autoPct) && typeof raw.lastKnown.readAt === "string"
      ? { lastKnown: { autoPct: raw.lastKnown.autoPct, readAt: raw.lastKnown.readAt, resetsAt: typeof raw.lastKnown.resetsAt === "string" ? raw.lastKnown.resetsAt : null } } : {}),
    readAt: raw.readAt,
    ...(raw.awaitingSample === true ? { awaitingSample: true } : {}),
    ok: raw.ok,
    error,
    includedPct: num(raw.includedPct),
    autoPct: num(raw.autoPct),
    apiPct: num(raw.apiPct),
    onDemandUsd: num(raw.onDemandUsd),
    onDemandLimitUsd: num(raw.onDemandLimitUsd),
    resetsAt: typeof raw.resetsAt === "string" ? raw.resetsAt : null,
    windows: windows.length > 0 ? windows : legacyWindows(raw),
    loggedOut: raw.loggedOut === true || (raw.ok === false && textSaysLoggedOut(error ?? "")),
    source: raw.source === "official" || raw.source === "screen" ? raw.source : raw.ok ? "screen" : null,
    linkState: raw.linkState === "connected" || raw.linkState === "broken" ? raw.linkState : "unlinked",
    linkBroken: raw.linkBroken === true,
    notice: typeof raw.notice === "string" ? raw.notice : null,
    homeAlarm: typeof raw.homeAlarm === "string" ? raw.homeAlarm.slice(0, 200) : null,
    ...(raw.screenRead === false ? { screenRead: false as const } : raw.screenRead === true ? { screenRead: true as const } : {}),
  };
}

function screenWindows(raw: unknown): CursorScreenWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: CursorScreenWindow[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const label = "label" in row && typeof row.label === "string" ? row.label : "";
    if (!label) continue;
    out.push({
      label,
      usedPct: num("usedPct" in row ? row.usedPct : null),
      onDemandUsd: num("onDemandUsd" in row ? row.onDemandUsd : null),
      onDemandLimitUsd: num("onDemandLimitUsd" in row ? row.onDemandLimitUsd : null),
      resetsAt: "resetsAt" in row && typeof row.resetsAt === "string" ? row.resetsAt : null,
    });
  }
  return out;
}

/** Files written before `windows` existed: rebuild the rows we already stored as fields. */
function legacyWindows(raw: Partial<CursorUsageReading>): CursorScreenWindow[] {
  const out: CursorScreenWindow[] = [];
  if (typeof raw.includedPct === "number") out.push({ label: "Included", usedPct: raw.includedPct, onDemandUsd: null, onDemandLimitUsd: null });
  if (typeof raw.autoPct === "number") out.push({ label: "Auto", usedPct: raw.autoPct, onDemandUsd: null, onDemandLimitUsd: null });
  if (typeof raw.apiPct === "number") out.push({ label: "API", usedPct: raw.apiPct, onDemandUsd: null, onDemandLimitUsd: null });
  if (typeof raw.onDemandUsd === "number") {
    out.push({ label: "On-Demand", usedPct: null, onDemandUsd: raw.onDemandUsd, onDemandLimitUsd: num(raw.onDemandLimitUsd) });
  }
  return out;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
