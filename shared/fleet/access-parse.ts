// Parse official status-command output. Only account, login state, and a scope count leave this file.
// Token-like values are dropped: gho_, ghp_, Bearer .
import { language, LANGUAGES, type Language, type MessageKey, t, tIn } from "./i18n";

export const SECRET_MARKERS = ["gho_", "ghp_", "ghu_", "ghs_", "github_pat_", "Bearer "];

export interface StatusCommand {
  bin: string;
  args: string[];
  /** Plugin id to inspect in a read-only plugin listing, supplied by the access map. */
  pluginId?: string;
}

/** Exact argv of status commands. login / logout / permission changes are not in this list. */
export const STATUS_COMMANDS: Record<string, StatusCommand> = {
  "cloudflare-cf": { bin: "cf", args: ["user", "get"] },
  vercel: { bin: "vercel", args: ["whoami"] },
  github: { bin: "gh", args: ["auth", "status"] },
  neon: { bin: "neonctl", args: ["me"] },
  claude: { bin: "claude", args: ["auth", "status", "--json"] },
  cursor: { bin: "cursor-agent", args: ["status", "--format", "json"] },
  codex: { bin: "codex", args: ["login", "status"] },
  supergrok: { bin: "grok", args: ["models"] },
  notion: { bin: "claude", args: ["mcp", "list"] },
  slack: { bin: "claude", args: ["mcp", "list"] },
  "slack-plugin": { bin: "paseo", args: ["plugin", "ls"] },
};

/** The Cursor CLI status. The access pass never runs it: the Cursor login watch (cursor-api adapter) does. */
export const CURSOR_STATUS: StatusCommand = STATUS_COMMANDS.cursor;

export function isCursorStatus(spec: StatusCommand | null | undefined): boolean {
  return Boolean(spec) && spec?.bin === CURSOR_STATUS.bin && spec.args.join("\0") === CURSOR_STATUS.args.join("\0");
}

/** `claude mcp list` walks every MCP server. It is not on the 30-minute pass. */
export function isSlowStatusCommand(bin: string, args: readonly string[]): boolean {
  return bin === "claude" && args.length === 2 && args[0] === "mcp" && args[1] === "list";
}

export function commandAllowed(bin: string, args: readonly string[]): boolean {
  return Object.values(STATUS_COMMANDS).some(
    (spec) => spec.bin === bin && spec.args.length === args.length && spec.args.every((arg, i) => arg === args[i]),
  );
}

export interface StatusOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  missing: boolean;
  abortedLogin: boolean;
}

export interface LiveCheck {
  state: "in" | "out" | "unknown";
  account: string | null;
  scopeCount: number | null;
  detail: string | null;
}

export function secretValue(text: string): boolean {
  const lower = text.toLowerCase();
  return SECRET_MARKERS.some((mark) => lower.includes(mark.toLowerCase()));
}

const MODES: Record<string, MessageKey> = {
  bypassPermissions: "access.mode.bypassPermissions",
  agent: "access.mode.agent",
  "full-access": "access.mode.fullAccess",
  accept_edits: "access.mode.acceptEdits",
  plan: "access.mode.plan",
  default: "access.mode.default",
};

export function modePlain(modeId: string | null): string {
  if (!modeId || secretValue(modeId)) return t("access.mode.none");
  const plain = Object.prototype.hasOwnProperty.call(MODES, modeId) ? MODES[modeId] : undefined;
  return plain ? t("access.mode.known", { plain: t(plain), id: modeId }) : t("access.mode.other", { id: modeId });
}

/** Words of one catalog entry written as `a|b|c`. */
function words(lang: Language, key: MessageKey): string[] {
  return tIn(lang, key).split("|").map((word) => word.toLowerCase()).filter(Boolean);
}

/** Text after `marker` (whitespace skipped) up to the sentence end; null when the marker is absent. */
function afterMarker(text: string, marker: string, end: string): string | null {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const rest = text.slice(at + marker.length).trimStart().split(end)[0] ?? "";
  return rest ? rest : null;
}

/** First `<special marker><colon>` in the notes, in the given language's words. */
function specialRule(text: string, lang: Language, end: string): string | null {
  const marker = tIn(lang, "access.notes.specialMarker");
  for (const colon of [...tIn(lang, "access.notes.colons")]) {
    const found = afterMarker(text, `${marker}${colon}`, end);
    if (found !== null) return found;
  }
  return null;
}

/** Prohibitions found with one language's markers (profile notes may be in any language). */
function restrictionBits(clean: string, lang: Language): { bits: string[]; join: string } {
  const end = tIn(lang, "access.notes.sentenceEnd");
  const bits: string[] = [];
  const pause = afterMarker(clean, tIn(lang, "access.notes.pauseMarker"), end);
  if (pause) bits.push(tIn(lang, "access.notes.pausePrefix", { text: pause.trim() }));
  const special = specialRule(clean, lang, end);
  if (special) bits.push(special.trim());
  if (special === null) {
    const negations = words(lang, "access.notes.negations");
    const boiler = words(lang, "access.notes.boilerplate");
    for (const sentence of clean.split(end)) {
      const text = sentence.trim();
      const lower = text.toLowerCase();
      if (!text || !negations.some((word) => lower.includes(word)) || boiler.some((word) => lower.includes(word))) continue;
      bits.push(text);
      if (bits.length >= 2) break;
    }
  }
  return { bits, join: end };
}

/** One or two short prohibitions from profile notes. Never the whole note. */
export function restrictionSummary(notes: string): string {
  const clean = notes.replace(/\s+/g, " ").trim();
  if (!clean || secretValue(clean)) return t("access.notes.none");
  const current = language();
  for (const lang of [current, ...LANGUAGES.filter((other) => other !== current)]) {
    const { bits, join } = restrictionBits(clean, lang);
    if (bits.length === 0) continue;
    const text = bits.join(join);
    const cut = text.length > 180 ? `${text.slice(0, 177)}…` : text;
    return secretValue(cut) ? t("access.notes.none") : cut;
  }
  return t("access.notes.none");
}

function short(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max || secretValue(text)) return null;
  return text;
}

function safeDetail(text: string): string | null {
  const line = text.split("\n").map((s) => s.trim()).find((s) => {
    if (!s || secretValue(s)) return false;
    return !/(token|secret|bearer|api[-_]?key|(^|\s)key\s*[:=])/i.test(s);
  });
  if (!line) return null;
  return line.replace(/\/Users\/\S+/g, "…").replace(/\s+/g, " ").slice(0, 80);
}

function readJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function accountNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const name = short((row as { name?: unknown }).name);
    if (name) names.push(name);
  }
  return names;
}

function joinAccounts(email: string | null, names: string[]): string | null {
  const labels = [...new Set(names.map((name) => (email && name.toLowerCase().includes(email.toLowerCase()) ? t("access.account.personal") : name)))];
  const list = labels.join(t("access.listJoin"));
  if (email && labels.length > 0) return withNote(email, list);
  if (email) return email;
  return labels.length > 0 ? list : null;
}

function withNote(account: string, note: string): string {
  return t("access.account.withNote", { account, note });
}

/** Detail when a status command gave nothing usable. */
function failedDetail(text: string, ok: boolean): string {
  return ok ? t("access.detail.unrecognized") : (safeDetail(text) ?? t("access.detail.commandFailed"));
}

function unknown(detail: string): LiveCheck {
  return { state: "unknown", account: null, scopeCount: null, detail };
}

function loggedOut(): LiveCheck {
  return { state: "out", account: null, scopeCount: null, detail: null };
}

function cloudflare(text: string, ok: boolean): LiveCheck {
  if (/no authentication token found|not authenticated|not logged|authentication error|invalid (?:access |api )?token|unauthorized/i.test(text) && !ok) return loggedOut();
  const json = readJsonObject(text);
  if (!ok || !json) return unknown(t(ok ? "access.detail.unrecognized" : "access.detail.commandFailed"));
  // `cf user get` emits the user object directly. Organization permissions are not token scopes.
  const account = joinAccounts(short(json.email) ?? short(json.username), accountNames(json.organizations));
  return account ? { state: "in", account, scopeCount: null, detail: null } : unknown(t("access.detail.unrecognized"));
}

function vercel(text: string, ok: boolean): LiveCheck {
  if (/no existing credentials|not logged|please [\s\S]{0,40}login/i.test(text)) return loggedOut();
  let account: string | null = null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || /^Vercel CLI/i.test(t) || /error|credential|login/i.test(t) || secretValue(t) || t.length > 80) continue;
    account = t;
    break;
  }
  if (account && ok) return { state: "in", account, scopeCount: null, detail: null };
  return unknown(failedDetail(text, ok));
}

function github(text: string, ok: boolean): LiveCheck {
  if (/not logged into any/i.test(text)) return loggedOut();
  const accounts = [...new Set([...text.matchAll(/account\s+(\S+)/gi)].map((m) => m[1]?.replace(/[()]/g, "") ?? "").filter((name) => name && !secretValue(name)))];
  const scopeLine = /Token scopes:\s*(.+)/i.exec(text);
  const scopeCount = scopeLine?.[1]
    ? scopeLine[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter((s) => s && !secretValue(s)).length
    : null;
  if ((/logged in/i.test(text) || ok) && accounts.length > 0) return { state: "in", account: accounts.join(t("access.listJoin")), scopeCount, detail: null };
  return unknown(failedDetail(text, ok));
}

function labeled(text: string, label: string): string | null {
  const matched = new RegExp(`^${label}\\s+(\\S+)`, "im").exec(text);
  return matched?.[1] && !secretValue(matched[1]) ? matched[1] : null;
}

function neon(text: string, ok: boolean): LiveCheck {
  if (/awaiting authentication/i.test(text)) return unknown(t("access.detail.loginStopped"));
  if (/cannot run interactive auth/i.test(text)) return unknown(t("access.detail.loginNoBrowser"));
  const json = readJsonObject(text);
  const login = json ? short(json.login) : labeled(text, "Login");
  const email = json ? short(json.email) : labeled(text, "Email");
  const account = email && login && login !== email ? withNote(email, login) : (email ?? login);
  if (account) return { state: "in", account, scopeCount: null, detail: null };
  return unknown(failedDetail(text, ok));
}

function claude(text: string, ok: boolean): LiveCheck {
  const json = readJsonObject(text);
  if (!json) {
    if (/not logged/i.test(text)) return loggedOut();
    return unknown(failedDetail(text, ok));
  }
  if (json.loggedIn === false) return loggedOut();
  const email = short(json.email);
  const sub = short(json.subscriptionType, 24);
  const account = email && sub ? withNote(email, sub) : email;
  if (json.loggedIn === true || account) return { state: "in", account, scopeCount: null, detail: null };
  return unknown(t("access.detail.unrecognized"));
}

function cursor(text: string, ok: boolean): LiveCheck {
  const json = readJsonObject(text);
  if (!json) {
    if (/not logged|not authenticated/i.test(text)) return loggedOut();
    return unknown(failedDetail(text, ok));
  }
  const user = json.userInfo && typeof json.userInfo === "object" ? (json.userInfo as Record<string, unknown>) : {};
  const email = short(user.email);
  const person = [short(user.firstName), short(user.lastName)].filter((part): part is string => Boolean(part)).join(" ");
  const account = email && person ? withNote(email, person) : email;
  const denied = json.isAuthenticated === false || json.status === "not_authenticated" || json.status === "unauthenticated";
  if (denied) return loggedOut();
  if (json.isAuthenticated === true || json.status === "authenticated" || account) return { state: "in", account, scopeCount: null, detail: null };
  return unknown(failedDetail(text, ok));
}

function codex(text: string, ok: boolean): LiveCheck {
  if (/not logged in/i.test(text)) return loggedOut();
  const via = /logged in using\s+([A-Za-z0-9._-]+)/i.exec(text);
  if (via) return { state: "in", account: short(via[1]), scopeCount: null, detail: null };
  if (/logged in/i.test(text)) return { state: "in", account: null, scopeCount: null, detail: null };
  return unknown(failedDetail(text, ok));
}

const grokMethod = (): string => t("access.detail.grokMethod");
const mcpMethod = (): string => t("access.detail.mcpMethod");

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function supergrok(text: string, ok: boolean): LiveCheck {
  if (/You are logged in with grok\.com\./i.test(text)) {
    return { state: "in", account: null, scopeCount: null, detail: grokMethod() };
  }
  if (/not logged in|please log in|run [`']?grok login|unauthenticated|no credentials/i.test(text)) {
    return { state: "out", account: null, scopeCount: null, detail: grokMethod() };
  }
  return unknown(failedDetail(text, ok));
}

function connectorStatus(text: string, name: "Notion" | "Slack", ok: boolean): LiveCheck {
  const method = t("access.detail.connector", { name, method: mcpMethod() });
  let status = "";
  let found = false;
  for (const raw of stripAnsi(text).split("\n")) {
    const line = raw.trim();
    const matched = new RegExp(`^claude\\.ai\\s+${name}\\s*:\\s*\\S+\\s+-\\s+(.+)$`, "i").exec(line);
    if (!matched?.[1]) continue;
    found = true;
    status = matched[1].trim();
    break;
  }
  if (!found) return unknown(ok ? t("access.detail.connectorMissing", { name, method: mcpMethod() }) : (safeDetail(text) ?? t("access.detail.commandFailed")));
  if (secretValue(status)) return { state: "unknown", account: null, scopeCount: null, detail: t("access.detail.tokenDropped") };
  const lower = status.toLowerCase();
  if (lower.includes("connected") && !lower.includes("needs authentication") && !lower.includes("failed")) {
    return { state: "in", account: null, scopeCount: null, detail: method };
  }
  if (lower.includes("needs authentication")) {
    return { state: "out", account: null, scopeCount: null, detail: t("access.detail.connectorNeedsAuth", { name, method: mcpMethod() }) };
  }
  if (lower.includes("failed") || status.includes("✘")) {
    return { state: "out", account: null, scopeCount: null, detail: t("access.detail.connectorFailed", { name, method: mcpMethod() }) };
  }
  return unknown(t("access.detail.connectorUnknown", { name, method: mcpMethod() }));
}

function slackPlugin(text: string, ok: boolean, pluginId?: string): LiveCheck {
  if (!pluginId?.trim() || secretValue(pluginId)) return unknown(t("access.detail.pluginUnconfigured"));
  const lines = stripAnsi(text).split("\n").map((line) => line.replace(/\s+$/, ""));
  const header = lines.find((line) => line.includes("PLUGIN") && line.includes("STATUS"));
  if (!header) return unknown(failedDetail(text, ok));
  const statusAt = header.indexOf("STATUS");
  const enabledAt = header.indexOf("ENABLED");
  if (statusAt < 0) return unknown(t("access.detail.unrecognized"));
  for (const line of lines) {
    if (line.slice(0, statusAt).trim() !== pluginId.trim()) continue;
    const status = line.slice(statusAt, enabledAt > statusAt ? enabledAt : statusAt + 16).trim().toLowerCase();
    if (!status || secretValue(status)) return { state: "unknown", account: null, scopeCount: null, detail: t("access.detail.tokenDropped") };
    if (status === "running") return { state: "in", account: null, scopeCount: null, detail: t("access.detail.slackRunning") };
    return { state: "out", account: null, scopeCount: null, detail: t("access.detail.slackStopped") };
  }
  return { state: "out", account: null, scopeCount: null, detail: t("access.detail.slackMissing") };
}

function scrub(row: LiveCheck): LiveCheck {
  const leaked = (row.account && secretValue(row.account)) || (row.detail && secretValue(row.detail));
  return {
    state: row.state,
    account: row.account && !secretValue(row.account) ? row.account : null,
    scopeCount: typeof row.scopeCount === "number" && Number.isFinite(row.scopeCount) ? row.scopeCount : null,
    detail: leaked ? t("access.detail.tokenDropped") : row.detail,
  };
}

/** One parser per entry of STATUS_COMMANDS, keyed the same way. */
const PARSERS: Record<string, (text: string, ok: boolean) => LiveCheck> = {
  "cloudflare-cf": cloudflare,
  vercel,
  github,
  neon,
  claude,
  cursor,
  codex,
  supergrok,
  notion: (text, ok) => connectorStatus(text, "Notion", ok),
  slack: (text, ok) => connectorStatus(text, "Slack", ok),
  "slack-plugin": slackPlugin,
};

export function parseStatusOutput(id: string, outcome: StatusOutcome, pluginId?: string): LiveCheck {
  if (outcome.timedOut) return unknown(t("access.detail.timedOut"));
  if (outcome.missing) return unknown(t("access.detail.commandMissing"));
  if (outcome.abortedLogin) return unknown(t("access.detail.loginStopped"));
  const text = `${outcome.stdout}\n${outcome.stderr}`;
  const parse = id === "slack-plugin" ? (text: string, ok: boolean) => slackPlugin(text, ok, pluginId)
    : Object.prototype.hasOwnProperty.call(PARSERS, id) ? PARSERS[id] : undefined;
  return scrub(parse ? parse(text, outcome.ok) : unknown(t("access.detail.noParser")));
}
