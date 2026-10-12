import { type DoctorFinding, type DoctorItem, makeItem } from "./doctor";
import { t } from "./i18n";
import { daysSince, type MigrationRecord, OBSERVATION_DAYS } from "./migration";
import { companyKeyOf } from "./quota-adapters";

// Judgement for each health check. Everything here is pure: the server reads the machine and hands the parsed
// data in, so every green / yellow / red threshold can be tested with a fixture. Thresholds are in DOCTOR.md.

export const QUOTA_YELLOW_MIN = 30;
export const QUOTA_RED_MIN = 120;
export const TIMEOUT_RED_COUNT = 3;
export const TIMEOUT_WINDOW_MIN = 60;
export const COUPON_SOON_DAYS = 7;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

const finding = (key: string, status: DoctorFinding["status"], text: string): DoctorFinding => ({ key, status, text });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const joinList = (items: readonly string[]): string => items.join(t("doctor.checks.listSeparator"));

export function ageText(minutes: number): string {
  if (minutes < 60) return t("doctor.age.minutes", { n: Math.round(minutes) });
  if (minutes < 48 * 60) return t("doctor.age.hours", { n: (minutes / 60).toFixed(1) });
  return t("doctor.age.days", { n: Math.round(minutes / 1440) });
}

// ---- a. quota readings

function quotaVerdict(paused: boolean, dispatchable: unknown): string {
  if (paused) return t("doctor.checks.quota.verdictPaused");
  return dispatchable === false ? t("doctor.checks.quota.verdictBlocked") : t("doctor.checks.quota.verdictOk");
}

export function checkQuota(poolStatus: unknown, disabledPools: string[], now: number, path: string): DoctorItem {
  const evidence = [path];
  const base = { id: "quota", title: t("doctor.checks.quota.title"), evidence };
  if (!isRecord(poolStatus)) {
    return makeItem({ ...base, summary: t("doctor.checks.quota.missingSummary"), findings: [finding("quota:missing", "red", t("doctor.checks.quota.missing"))] });
  }
  const at = Date.parse(str(poolStatus.generatedAt) ?? "");
  const findings: DoctorFinding[] = [];
  let summary: string;
  if (Number.isNaN(at)) {
    findings.push(finding("quota:age", "red", t("doctor.checks.quota.noTime")));
    summary = t("doctor.checks.quota.noTimeSummary");
  } else {
    const minutes = Math.max(0, (now - at) / MIN_MS);
    const status = minutes > QUOTA_RED_MIN ? "red" : minutes > QUOTA_YELLOW_MIN ? "yellow" : "green";
    const age = ageText(minutes);
    summary = status === "green" ? t("doctor.checks.quota.fresh", { age }) : t("doctor.checks.quota.stale", { age });
    findings.push(finding("quota:age", status, t("doctor.checks.quota.age", { at: new Date(at).toISOString(), age, yellowMin: QUOTA_YELLOW_MIN, redHours: QUOTA_RED_MIN / 60 })));
  }
  const pools = isRecord(poolStatus.pools) ? poolStatus.pools : {};
  for (const [name, raw] of Object.entries(pools)) {
    const pool = isRecord(raw) ? raw : {};
    const used = num(pool.usedPct);
    const verdict = quotaVerdict(disabledPools.includes(name), pool.dispatchable);
    findings.push(finding(`quota:pool:${name}`, "green", t("doctor.checks.quota.pool", { name, used: used === null ? "?" : `${Math.round(used)}%`, verdict })));
  }
  return makeItem({ ...base, summary, findings });
}

// ---- b. profiles

export interface DoctorProfile {
  name: string;
  provider: string;
  model: string;
  role: string | null;
  candidateFor: string | null;
  pool: string | null;
  family: string | null;
}

export interface ProviderState {
  provider: string;
  label: string;
  status: string;
  enabled: boolean;
}

export function stripContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/, "");
}

export function parseProfiles(config: unknown): DoctorProfile[] {
  const list = isRecord(config) && isRecord(config.daemon) ? asArray(config.daemon.agentProfiles) : [];
  const out: DoctorProfile[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const name = str(raw.name);
    if (!name) continue;
    out.push({
      name,
      provider: str(raw.provider) ?? "",
      model: str(raw.model) ?? "",
      role: str(raw.role),
      candidateFor: str(raw.candidateFor),
      pool: str(raw.pool),
      family: str(raw.family),
    });
  }
  return out;
}

/** Personal profiles that are not a role's candidate are the user's own tools, not part of the dispatch chain. */
export const inDispatchChain = (profile: DoctorProfile): boolean => profile.role !== "personal" || profile.candidateFor !== null;

/** A profile on a paused pool is not dispatched; that is listed, not an error. */
const onPausedPool = (profile: DoctorProfile, disabledPools: string[]): boolean => profile.pool !== null && disabledPools.includes(profile.pool);

function checkOneProfile(profile: DoctorProfile, models: Record<string, string[] | null>, providers: ProviderState[], disabledPools: string[]): DoctorFinding {
  const key = `profile:${profile.name}`;
  const label = t("doctor.checks.profiles.label", { name: profile.name, provider: profile.provider, model: profile.model });
  const provider = profile.provider;
  if (onPausedPool(profile, disabledPools)) return finding(key, "green", t("doctor.checks.profiles.paused", { label, pool: profile.pool ?? "" }));
  const state = providers.find((row) => row.provider === provider);
  if (!state) return finding(key, "red", t("doctor.checks.profiles.noProvider", { label, provider }));
  if (!state.enabled) return finding(key, "red", t("doctor.checks.profiles.providerOff", { label, provider }));
  const list = models[provider];
  if (!list) return finding(key, "yellow", t("doctor.checks.profiles.noModels", { label, provider }));
  const known = new Set(list.map(stripContextSuffix));
  if (!known.has(stripContextSuffix(profile.model))) return finding(key, "red", t("doctor.checks.profiles.modelMissing", { label, provider }));
  return finding(key, "green", t("doctor.checks.profiles.modelOk", { label }));
}

function checkModelSplit(profiles: DoctorProfile[]): DoctorFinding {
  const main = (role: string) => profiles.find((profile) => profile.role === role && profile.candidateFor === null);
  const executor = main("executor");
  const reviewer = main("reviewer");
  if (!executor || !reviewer) return finding("profiles:model", "yellow", t("doctor.checks.profiles.modelNoMain"));
  if (!executor.model.trim() || !reviewer.model.trim()) return finding("profiles:model", "red", t("doctor.checks.profiles.reviewModelMissing", { executor: executor.name, reviewer: reviewer.name }));
  if (executor.model.trim().toLowerCase() === reviewer.model.trim().toLowerCase()) return finding("profiles:model", "red", t("doctor.checks.profiles.modelSame", { model: executor.model }));
  return finding("profiles:model", "green", t("doctor.checks.profiles.modelDifferent", { executor: executor.model, reviewer: reviewer.model }));
}

function profilesSummary(count: number, unchecked: boolean, bad: number, idle: number): string {
  if (count === 0) return t("doctor.checks.profiles.summaryNone");
  if (unchecked) return t("doctor.checks.profiles.summaryUnchecked", { count });
  const result = bad === 0 ? t("doctor.checks.profiles.summaryAllOk") : t("doctor.checks.profiles.summaryBad", { count: bad });
  return t("doctor.checks.profiles.summaryChecked", { count, result, idle: idle ? t("doctor.checks.profiles.summaryIdle", { count: idle }) : "" });
}

export function checkProfiles(input: {
  profiles: DoctorProfile[];
  models: Record<string, string[] | null>;
  /** null when `paseo provider ls` itself failed: one finding instead of a red per profile. */
  providers: ProviderState[] | null;
  disabledPools: string[];
}): DoctorItem {
  const chain = input.profiles.filter(inDispatchChain);
  const providers = input.providers;
  const findings = [
    ...(providers === null
      ? [finding("profiles:providers", "yellow", t("doctor.checks.profiles.providersUnreadable"))]
      : chain.map((profile) => checkOneProfile(profile, input.models, providers, input.disabledPools))),
    checkModelSplit(chain),
  ];
  const profileRows = findings.filter((row) => row.key.startsWith("profile:"));
  const bad = profileRows.filter((row) => row.status !== "green").length;
  const unchecked = providers === null;
  const idle = unchecked ? 0 : chain.filter((profile) => onPausedPool(profile, input.disabledPools)).length;
  const summary = profilesSummary(chain.length, unchecked, bad, idle);
  if (chain.length === 0) findings.unshift(finding("profiles:none", "red", t("doctor.checks.profiles.none")));
  return makeItem({
    id: "profiles",
    title: t("doctor.checks.profiles.title"),
    summary,
    evidence: [t("doctor.checks.profiles.evidenceProfiles"), "paseo provider models <provider>"],
    findings,
  });
}

// ---- c. services

/** Count "Timed out refreshing <name>" log lines per service name inside the window. */
export function countRefreshTimeouts(lines: readonly string[], now: number, windowMin = TIMEOUT_WINDOW_MIN): Record<string, number> {
  const since = now - windowMin * MIN_MS;
  const counts: Record<string, number> = {};
  for (const line of lines) {
    if (!line.includes("Timed out refreshing")) continue;
    const time = /"time":(\d{10,})/.exec(line);
    if (!time || Number(time[1]) < since) continue;
    const name = /Timed out refreshing (.+?) after \d+ms/.exec(line)?.[1] ?? t("doctor.checks.services.unknownService");
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function serviceFinding(row: ProviderState): DoctorFinding {
  const key = `service:${row.provider}`;
  const label = t("doctor.checks.services.label", { label: row.label, provider: row.provider });
  if (!row.enabled) return finding(key, "green", t("doctor.checks.services.off", { label }));
  if (row.status === "available") return finding(key, "green", t("doctor.checks.services.available", { label }));
  return finding(key, "red", t("doctor.checks.services.down", { label, status: row.status }));
}

function servicesSummary(providers: ProviderState[], badCount: number, logProblem: string | null | undefined): string {
  const count = providers.length;
  if (count === 0) return t("doctor.checks.services.summaryNone");
  if (badCount > 0) return t("doctor.checks.services.summaryBad", { count: badCount });
  if (logProblem) return t("doctor.checks.services.summaryNoLog", { count });
  const off = providers.filter((row) => !row.enabled).length;
  return t("doctor.checks.services.summaryOk", { count, on: count - off, off });
}

export function checkServices(input: { providers: ProviderState[]; timeouts: Record<string, number>; logProblem?: string | null }): DoctorItem {
  const findings: DoctorFinding[] = [];
  if (input.logProblem) findings.push(finding("service:log", "yellow", t("doctor.checks.services.logProblem", { problem: input.logProblem })));
  for (const row of input.providers) findings.push(serviceFinding(row));
  for (const [name, count] of Object.entries(input.timeouts).sort((a, b) => b[1] - a[1])) {
    const red = count >= TIMEOUT_RED_COUNT;
    const extra = red ? t("doctor.checks.services.timeoutRed", { limit: TIMEOUT_RED_COUNT }) : "";
    findings.push(finding(`service:timeout:${name}`, red ? "red" : "green", t("doctor.checks.services.timeout", { name, window: TIMEOUT_WINDOW_MIN, count, extra })));
  }
  const bad = findings.filter((row) => row.status === "red");
  const summary = servicesSummary(input.providers, bad.length, input.logProblem);
  if (input.providers.length === 0) findings.push(finding("service:none", "red", t("doctor.checks.services.none")));
  return makeItem({ id: "services", title: t("doctor.checks.services.title"), summary, evidence: ["paseo provider ls --json", t("doctor.checks.services.evidenceLog")], findings });
}

// ---- d. Claude Code

export interface ClaudeBinary {
  path: string;
  real: string;
  version: string | null;
}

export interface ClaudeSession {
  pid: number;
  path: string;
  real: string;
  version: string | null;
}

const DESKTOP_APP_MARK = "/Library/Application Support/Claude/claude-code/";

const SESSION_LINE = /^\s*(\d+)\s+(\/.*?\/claude(?:\.app\/Contents\/MacOS\/claude)?)\s+(?:--output-format|-p\s)/;

/** Claude agent sessions from `ps -axo pid,command`. The desktop app's disclaimer wrapper and helper processes are skipped. */
export function parseClaudeSessions(psOutput: string): Array<{ pid: number; path: string }> {
  const out: Array<{ pid: number; path: string }> = [];
  for (const line of psOutput.split("\n")) {
    if (line.includes("/Helpers/disclaimer")) continue;
    const hit = SESSION_LINE.exec(line);
    if (hit) out.push({ pid: Number(hit[1]), path: hit[2] });
  }
  return out;
}

interface ClaudeCodeInput { configCommand: string | null; configReal: string | null; configVersion: string | null; pathBinaries: ClaudeBinary[]; sessions: ClaudeSession[] }

function claudePathFindings(input: ClaudeCodeInput): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const seen = new Set<string>();
  for (const bin of input.pathBinaries) {
    if (bin.real === input.configReal || seen.has(bin.real)) continue;
    seen.add(bin.real);
    const same = bin.version !== null && bin.version === input.configVersion;
    const match = same ? t("doctor.checks.claude.pathSame") : t("doctor.checks.claude.pathDiff", { version: input.configVersion ?? "?" });
    findings.push(finding(`claude:path:${bin.path}`, same ? "green" : "yellow", t("doctor.checks.claude.pathOther", { path: bin.path, version: bin.version ?? t("doctor.checks.claude.versionNotFound"), match })));
  }
  return findings;
}

function claudeSessionFindings(input: ClaudeCodeInput): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const away = input.sessions.filter((row) => row.real !== input.configReal && !row.path.includes(DESKTOP_APP_MARK));
  const desktop = input.sessions.filter((row) => row.path.includes(DESKTOP_APP_MARK));
  // A session on another path with the same version is harmless; a different or unknown version is the old-session case.
  const off = away.filter((row) => row.version === null || row.version !== input.configVersion);
  if (off.length > 0) {
    const paths = joinList([...new Set(off.map((row) => t("doctor.checks.claude.sessionPath", { path: row.path, version: row.version ?? t("doctor.checks.claude.sessionVersionUnknown") })))]);
    findings.push(finding("claude:sessions", "yellow", t("doctor.checks.claude.sessionsOff", { count: off.length, paths, version: input.configVersion ?? "?" })));
  } else {
    const detail = away.length > 0 ? t("doctor.checks.claude.sessionsAwaySame", { count: away.length }) : "";
    findings.push(finding("claude:sessions", "green", t("doctor.checks.claude.sessionsOk", { count: input.sessions.length - desktop.length, detail })));
  }
  if (desktop.length > 0) {
    const versions = joinList([...new Set(desktop.map((row) => row.path.split("/claude-code/")[1]?.split("/")[0] ?? "?"))]);
    findings.push(finding("claude:desktop", "green", t("doctor.checks.claude.desktop", { count: desktop.length, versions })));
  }
  return findings;
}

export function checkClaudeCode(input: ClaudeCodeInput): DoctorItem {
  const evidence = [t("doctor.checks.claude.evidenceConfig"), t("doctor.checks.claude.evidenceWhich"), "ps -axo pid,command"];
  const findings: DoctorFinding[] = [];
  if (!input.configCommand) {
    return makeItem({ id: "claude-code", title: "Claude Code", summary: t("doctor.checks.claude.noConfigSummary"), evidence, findings: [finding("claude:config", "red", t("doctor.checks.claude.noConfig"))] });
  }
  if (!input.configVersion) findings.push(finding("claude:config", "red", t("doctor.checks.claude.configNoVersion", { command: input.configCommand })));
  else findings.push(finding("claude:config", "green", t("doctor.checks.claude.configOk", { command: input.configCommand, version: input.configVersion })));
  findings.push(...claudePathFindings(input), ...claudeSessionFindings(input));
  const yellow = findings.some((row) => row.status === "yellow");
  const red = findings.some((row) => row.status === "red");
  const summary = red
    ? t("doctor.checks.claude.summaryRed")
    : yellow ? t("doctor.checks.claude.summaryYellow") : t("doctor.checks.claude.summaryOk", { version: String(input.configVersion) });
  return makeItem({ id: "claude-code", title: "Claude Code", summary, evidence, findings });
}

// ---- e. leftovers in /tmp

export const isTmpPath = (path: string): boolean => /^(\/private)?\/tmp(\/|$)/.test(path);

export function checkResidue(input: { workspaces: Array<{ workspaceId: string; project: string; name: string; cwd: string }>; projects: Array<{ projectId: string; name: string; path: string }> }): DoctorItem {
  const findings: DoctorFinding[] = [];
  for (const row of input.workspaces.filter((ws) => isTmpPath(ws.cwd))) {
    findings.push(finding(`residue:workspace:${row.workspaceId}`, "yellow", t("doctor.checks.residue.workspace", { name: row.name, project: row.project, cwd: row.cwd })));
  }
  for (const row of input.projects.filter((project) => isTmpPath(project.path))) {
    findings.push(finding(`residue:project:${row.projectId}`, "yellow", t("doctor.checks.residue.project", { name: row.name, path: row.path })));
  }
  if (findings.length === 0) findings.push(finding("residue:none", "green", t("doctor.checks.residue.none", { workspaces: input.workspaces.length, projects: input.projects.length })));
  const count = findings.filter((row) => row.status === "yellow").length;
  return makeItem({
    id: "residue",
    title: t("doctor.checks.residue.title"),
    summary: count === 0 ? t("doctor.checks.residue.summaryNone") : t("doctor.checks.residue.summaryFound", { count }),
    evidence: ["paseo workspace ls --json", "paseo project ls --json"],
    findings,
  });
}

// ---- f. schedules

export interface ScheduleRow {
  id: string;
  name: string;
  status: string;
  lastRun: { status: string; startedAt: string | null; error: string | null } | null;
  logsError: string | null;
}

const FAILED_RUN = /fail|error|timeout|timed_out|cancel/i;
const OK_RUN = /^(succeeded|success|completed|ok|running|pending|queued)$/i;

function scheduleFinding(row: ScheduleRow): DoctorFinding {
  const key = `schedule:${row.id}`;
  const label = t("doctor.checks.schedules.label", { name: row.name, id: row.id });
  if (row.status !== "active") {
    return finding(key, "green", t("doctor.checks.schedules.inactive", { label, status: row.status === "paused" ? t("doctor.checks.schedules.paused") : row.status }));
  }
  if (row.logsError) return finding(key, "yellow", t("doctor.checks.schedules.logsError", { label, error: row.logsError }));
  const run = row.lastRun;
  if (!run) return finding(key, "green", t("doctor.checks.schedules.neverRan", { label }));
  const at = run.startedAt ?? "?";
  if (FAILED_RUN.test(run.status)) {
    const error = run.error ? t("doctor.checks.schedules.failedError", { error: run.error.slice(0, 120) }) : "";
    return finding(key, "red", t("doctor.checks.schedules.failed", { label, at, status: run.status, error }));
  }
  if (!OK_RUN.test(run.status)) return finding(key, "yellow", t("doctor.checks.schedules.unknown", { label, status: run.status }));
  return finding(key, "green", t("doctor.checks.schedules.ok", { label, status: run.status, at }));
}

export function checkSchedules(rows: ScheduleRow[]): DoctorItem {
  const findings = rows.map(scheduleFinding);
  const failed = findings.filter((row) => row.status === "red").length;
  const inactive = rows.filter((row) => row.status !== "active").length;
  const okSummary = () => t("doctor.checks.schedules.summaryOk", { count: rows.length, inactive: inactive ? t("doctor.checks.schedules.summaryInactive", { count: inactive }) : "" });
  return makeItem({
    id: "schedules",
    title: t("doctor.checks.schedules.title"),
    summary: rows.length === 0 ? t("doctor.checks.schedules.summaryNone") : failed > 0 ? t("doctor.checks.schedules.summaryFailed", { count: failed }) : okSummary(),
    evidence: ["paseo schedule ls --json", "paseo schedule logs <id> --json"],
    findings,
  });
}

// ---- g. compatibility

export function checkCompat(state: unknown, now: number, path: string): DoctorItem {
  const base = { id: "compat", title: t("doctor.checks.compat.title"), evidence: [path] };
  const results = isRecord(state) ? asArray(state.results).filter(isRecord) : [];
  if (results.length === 0) {
    return makeItem({ ...base, summary: t("doctor.checks.compat.summaryNone"), findings: [finding("compat:none", "yellow", t("doctor.checks.compat.none"))] });
  }
  const findings = results.map((row) => {
    const id = str(row.id) ?? "?";
    const status = str(row.status) ?? "?";
    const conclusion = str(row.conclusion);
    const label = t("doctor.checks.compat.row", { label: str(row.label) ?? id, status, conclusion: conclusion ? t("doctor.checks.compat.rowConclusion", { conclusion }) : "" });
    return finding(`compat:${id}`, status === "pass" ? "green" : "red", label);
  });
  const recordedAt = Date.parse(isRecord(state) ? str(state.recordedAt) ?? "" : "");
  const when = Number.isNaN(recordedAt) ? t("doctor.checks.compat.whenUnknown") : t("doctor.checks.compat.ago", { age: ageText(Math.max(0, now - recordedAt) / MIN_MS) });
  const failed = findings.filter((row) => row.status === "red").length;
  const version = (isRecord(state) ? str(state.version) : null) ?? "?";
  return makeItem({ ...base, summary: failed === 0 ? t("doctor.checks.compat.summaryOk", { version, when }) : t("doctor.checks.compat.summaryFailed", { count: failed, version, when }), findings });
}

// ---- h. reset coupons

interface CouponLine { company: string; count: number; expiresAt: string | null }

function earliest(dates: Array<string | null>): string | null {
  const ok = dates.filter((date): date is string => date !== null && !Number.isNaN(Date.parse(date))).sort();
  return ok[0] ?? null;
}

/**
 * Same trust rule as the quota page (reset-coupons-view.ts shownOf): a reading confirmed by the CLI (via cli/paseo,
 * status ok, or the kept last good one when unreadable) is used even when it says 0 coupons. plans.json (typed by
 * hand) is only used when there is no such confirmation: missing record, via plans, status manual/off.
 */
export function couponLines(couponState: unknown, plans: unknown): CouponLine[] {
  const companies = isRecord(couponState) && isRecord(couponState.companies) ? couponState.companies : {};
  const fromPlans: Record<string, CouponLine> = {};
  for (const plan of isRecord(plans) ? asArray(plans.plans).filter(isRecord) : []) {
    const id = str(plan.id);
    if (!id) continue;
    // The coupon state's company key (shared/quota-adapters.ts companyKeyOf).
    const company = companyKeyOf({ ...plan, id } as Parameters<typeof companyKeyOf>[0]);
    const coupons = asArray(plan.resetCoupons).filter(isRecord);
    const count = coupons.reduce((sum, row) => sum + (num(row.count) ?? 0), 0);
    fromPlans[company] = { company, count, expiresAt: earliest(coupons.map((row) => str(row.expiresAt))) };
  }
  const names = new Set([...Object.keys(companies), ...Object.keys(fromPlans)]);
  return [...names].map((company) => {
    const live = isRecord(companies[company]) ? companies[company] : {};
    const trusted = live.via === "cli" || live.via === "paseo";
    const confirmed = trusted && Boolean(str(live.confirmedAt)) && (live.status === "ok" || live.status === "unreadable");
    if (confirmed) {
      const items = asArray(live.items).filter(isRecord).map((row) => str(row.expiresAt));
      return { company, count: num(live.count) ?? 0, expiresAt: earliest([...items, str(live.expiresAt)]) };
    }
    return fromPlans[company] ?? { company, count: 0, expiresAt: null };
  });
}

function couponFinding(line: CouponLine, now: number): DoctorFinding {
  const key = `coupon:${line.company}`;
  const { company, count } = line;
  if (count === 0) return finding(key, "green", t("doctor.checks.coupons.zero", { company }));
  if (!line.expiresAt) return finding(key, "green", t("doctor.checks.coupons.noExpiry", { company, count }));
  const days = (Date.parse(line.expiresAt) - now) / DAY_MS;
  const soon = days <= COUPON_SOON_DAYS;
  const when = days < 0 ? t("doctor.checks.coupons.expired", { days: Math.ceil(-days) }) : t("doctor.checks.coupons.expiresIn", { days: Math.ceil(days) });
  const soonNote = soon ? t("doctor.checks.coupons.soonNote", { days: COUPON_SOON_DAYS }) : "";
  return finding(key, soon ? "yellow" : "green", t("doctor.checks.coupons.line", { company, count, date: line.expiresAt.slice(0, 10), when, soon: soonNote }));
}

/** `evidence` names the two files read; the server passes their real paths. */
export function checkCoupons(
  couponState: unknown,
  plans: unknown,
  now: number,
  evidence: string[] = ["<data dir>/reset-coupons.json", "<data dir>/plans.json"],
): DoctorItem {
  const findings = couponLines(couponState, plans).map((line) => couponFinding(line, now));
  const soon = findings.filter((row) => row.status === "yellow").length;
  const total = couponLines(couponState, plans).reduce((sum, line) => sum + line.count, 0);
  return makeItem({
    id: "coupons",
    title: t("doctor.checks.coupons.title"),
    summary: soon > 0 ? t("doctor.checks.coupons.summarySoon", { count: soon, days: COUPON_SOON_DAYS }) : t("doctor.checks.coupons.summaryOk", { total, days: COUPON_SOON_DAYS }),
    evidence,
    findings,
  });
}

// ---- i. Kanban

export interface KanbanDoctorOutcome {
  /** Kanban is not installed (no exports/kanban.json): nothing to check, and that is not a problem. */
  absent?: boolean;
  ran: boolean;
  ok: boolean;
  timedOut: boolean;
  error: string | null;
  json: unknown;
}

export const KANBAN_REPORT_STALE_MIN = 90;

function kanbanSummary(red: number, yellow: number, stale: boolean): string {
  if (red > 0) return t("doctor.checks.kanban.summaryRed", { count: red });
  if (yellow > 0) return t("doctor.checks.kanban.summaryYellow", { count: yellow });
  return stale ? t("doctor.checks.kanban.summaryStale") : t("doctor.checks.kanban.summaryOk");
}

/** Reads the last report the board wrote itself (`kanban doctor --last --json`, every 30 minutes); never runs a fresh one. */
/** `bin` is the board's command as shown to the user; the server passes its real path. */
export function checkKanban(outcome: KanbanDoctorOutcome, now: number, bin = "kanban"): DoctorItem {
  const evidence = [t("doctor.checks.kanban.evidence", { bin })];
  const base = { id: "kanban", title: t("doctor.checks.kanban.title"), evidence };
  if (outcome.absent) {
    return makeItem({ ...base, evidence: ["exports/kanban.json"], summary: "Kanban is not installed; board checks skipped", findings: [finding("kanban:absent", "green", "kanban absent: no exports/kanban.json, so the board panels and the idle sweep are off")] });
  }
  if (!outcome.ran) return makeItem({ ...base, summary: t("doctor.checks.kanban.missingSummary"), findings: [finding("kanban:missing", "yellow", t("doctor.checks.kanban.missing", { bin }))] });
  if (outcome.timedOut) return makeItem({ ...base, summary: t("doctor.checks.kanban.timeoutSummary"), findings: [finding("kanban:timeout", "yellow", t("doctor.checks.kanban.timeout"))] });
  const json = outcome.json;
  if (!isRecord(json) || !isRecord(json.counts)) {
    const error = (outcome.error ?? t("doctor.checks.kanban.noOutput")).slice(0, 160);
    return makeItem({ ...base, summary: t("doctor.checks.kanban.errorSummary"), findings: [finding("kanban:error", "yellow", t("doctor.checks.kanban.error", { error }))] });
  }
  const red = num(json.counts.red) ?? 0;
  const yellow = num(json.counts.yellow) ?? 0;
  const findings: DoctorFinding[] = [finding("kanban:counts", red > 0 ? "red" : yellow > 0 ? "yellow" : "green", t("doctor.checks.kanban.counts", { red, yellow, info: num(json.counts.info) ?? 0 }))];
  const seen = new Set<string>();
  for (const row of asArray(json.findings).filter(isRecord)) {
    const severity = str(row.severity);
    if (severity !== "red" && severity !== "yellow") continue;
    const label = `${str(row.project) ?? ""} ${str(row.card) ?? ""} ${str(row.symptom) ?? "?"}`.replace(/\s+/g, " ").trim();
    if (seen.has(label)) continue;
    seen.add(label);
    findings.push(finding(`kanban:${label}`, severity, label));
  }
  const reportAt = Date.parse(str(json.at) ?? "");
  const ageMin = Number.isNaN(reportAt) ? null : Math.max(0, now - reportAt) / MIN_MS;
  const stale = ageMin === null || ageMin > KANBAN_REPORT_STALE_MIN;
  if (stale) findings.push(finding("kanban:stale", "yellow", ageMin === null ? t("doctor.checks.kanban.staleNoTime") : t("doctor.checks.kanban.stale", { age: ageText(ageMin) })));
  return makeItem({ ...base, summary: kanbanSummary(red, yellow, stale), findings });
}

// ---- j. Data directory

export interface DataDirView {
  dir: string;
  source: "override" | "data-dir" | "legacy";
  /** Where the data lives once migrated. */
  dataDir: string;
}

/** Information only: which data directory is in use. Still on the legacy directory means "not migrated yet". */
export function checkDataDir(view: DataDirView): DoctorItem {
  const base = { id: "data-dir", title: "Data directory", evidence: [view.dir] };
  if (view.source === "legacy") {
    return makeItem({
      ...base,
      summary: `Not migrated yet: using the legacy state directory ${view.dir} (after migration: ${view.dataDir})`,
      findings: [finding("data-dir:legacy", "green", "Not migrated yet; `afc migrate --from <legacy dir>` moves it when you are ready")],
    });
  }
  const why = view.source === "override" ? " (from AFC_DATA_DIR)" : "";
  return makeItem({ ...base, summary: `Using ${view.dir}${why}`, findings: [] });
}

// ---- k. Migration check: the observation period after `afc migrate` (shared/migration.ts)

export interface LegacyFileView {
  from: string;
  recorded: { size: number; mtimeMs: number };
  /** Null when the legacy file is gone. */
  now: { size: number; mtimeMs: number } | null;
}

export type MigrationView =
  | { state: "absent"; path: string }
  | { state: "invalid"; path: string; reason: string }
  | { state: "ok"; path: string; record: MigrationRecord; decisionsNow: number | null; legacy: LegacyFileView[]; usingLegacy: boolean };

const MIGRATION_TITLE = "Migration check";
const LEGACY_LISTED = 5;

function listNames(names: readonly string[]): string {
  const head = names.slice(0, LEGACY_LISTED).join(", ");
  return names.length > LEGACY_LISTED ? `${head} and ${names.length - LEGACY_LISTED} more` : head;
}

function activeMigrationFindings(view: Extract<MigrationView, { state: "ok" }>, now: number): DoctorFinding[] {
  const { record } = view;
  const findings: DoctorFinding[] = [];
  if (view.usingLegacy) findings.push(finding("migration:not-in-use", "red", `The cockpit reads the legacy directory although migration ${record.id} is active; decisions.json and plans.json are missing from ${record.to}`));
  const copied = record.checks.decisions;
  if (copied !== null) {
    if (view.decisionsNow === null) findings.push(finding("migration:decisions-unreadable", "yellow", `decisions.json in ${record.to} is missing or unreadable (${copied} items at migration)`));
    else if (view.decisionsNow < copied) findings.push(finding("migration:decisions-shrank", "red", `decisions.json has ${view.decisionsNow} items, fewer than the ${copied} copied at migration`));
    else findings.push(finding("migration:decisions", "green", `decisions.json: ${view.decisionsNow} items (${copied} at migration)`));
  }
  const missing = view.legacy.filter((file) => file.now === null).map((file) => file.from);
  const changed = view.legacy.filter((file) => file.now !== null && (file.now.size !== file.recorded.size || file.now.mtimeMs !== file.recorded.mtimeMs)).map((file) => file.from);
  if (changed.length > 0) findings.push(finding("migration:legacy-changed", "yellow", `Legacy files changed after migration, so something still writes to ${record.from}: ${listNames(changed)}`));
  if (missing.length > 0) findings.push(finding("migration:legacy-missing", "yellow", `Legacy files are gone before --finish: ${listNames(missing)}`));
  if (changed.length === 0 && missing.length === 0) findings.push(finding("migration:legacy", "green", `Legacy directory untouched (${view.legacy.length} files)`));
  const days = daysSince(record.migratedAt, now);
  findings.push(
    days >= OBSERVATION_DAYS
      ? finding("migration:observation-over", "green", `Observation period over (${days} days): finish with \`afc migrate --finish ${record.id}\``)
      : finding("migration:observation", "green", `Day ${days} of ${OBSERVATION_DAYS} of the observation period`),
  );
  return findings;
}

/** After `afc migrate`: the data directory only grew and the legacy directory stayed as it was. */
export function checkMigration(view: MigrationView, now: number): DoctorItem {
  const base = { id: "migration", title: MIGRATION_TITLE, evidence: [view.path] };
  if (view.state === "absent") return makeItem({ ...base, summary: "No migration recorded", findings: [] });
  if (view.state === "invalid") {
    return makeItem({ ...base, summary: "MIGRATION.json is unreadable", findings: [finding("migration:invalid", "yellow", `MIGRATION.json is unreadable: ${view.reason}`)] });
  }
  const { record } = view;
  if (record.status === "rolled-back") return makeItem({ ...base, summary: `Migration ${record.id} was rolled back (${record.rolledBackAt ?? "?"}); the legacy directory is in use`, findings: [] });
  if (record.status === "finished") return makeItem({ ...base, summary: `Migration ${record.id} finished (${record.finishedAt ?? "?"}); legacy files archived in ${record.finish?.archive ?? "?"}`, findings: [] });
  const findings = activeMigrationFindings(view, now);
  const problem = findings.find((row) => row.status === "red") ?? findings.find((row) => row.status === "yellow");
  const days = daysSince(record.migratedAt, now);
  const summary = problem ? problem.text : `Migration ${record.id}: day ${days} of ${OBSERVATION_DAYS}; the data only grew and the legacy directory is untouched`;
  return makeItem({ ...base, summary, findings });
}
