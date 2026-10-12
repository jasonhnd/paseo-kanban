import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { poolLabel, roleLabel as dispatchRoleLabel } from "./dispatch";
import { type MessageKey, t, tAll } from "./i18n";
import {
  commandAllowed,
  isSlowStatusCommand,
  type LiveCheck,
  modePlain,
  restrictionSummary,
  secretValue,
  STATUS_COMMANDS,
  type StatusCommand,
} from "./access-parse";

export interface MapService {
  id: string;
  name: string;
  login: string;
  accountNote: string;
  permission: string;
  constraint: string;
  roles: string[];
  noDispatch: boolean;
  check: StatusCommand | null;
  also: StatusCommand | null;
  kind: "login" | "link";
  blocked: boolean;
  unchecked: string | null;
}

export interface AccessProfile {
  name: string;
  role: string | null;
  provider: string;
  model: string | null;
  modeId: string | null;
  pool: string | null;
  notes: string;
}

const EXTRA_ROLE: Record<string, MessageKey> = {
  candidate: "access.role.candidate",
  personal: "access.role.personal",
  patrol: "access.role.patrol",
};

const VENDOR: Record<string, string> = {
  claude: "Claude",
  grok: "SuperGrok",
  cursor: "Cursor",
  codex: "Codex",
  "example-agent": "Example Agent",
};

function prose(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || secretValue(text)) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function readCheck(value: unknown): StatusCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as { bin?: unknown; args?: unknown; pluginId?: unknown };
  if (typeof row.bin !== "string" || !Array.isArray(row.args) || row.args.some((arg) => typeof arg !== "string")) return null;
  return { bin: row.bin, args: row.args as string[], ...(typeof row.pluginId === "string" ? { pluginId: row.pluginId } : {}) };
}

function sameCommand(spec: StatusCommand | undefined, check: StatusCommand | null): boolean {
  if (!spec || !check) return false;
  return spec.bin === check.bin && spec.args.length === check.args.length && spec.args.every((arg, i) => arg === check.args[i]);
}

export function parseAccessMap(raw: unknown): MapService[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { services?: unknown }).services)
    ? (raw as { services: unknown[] }).services
    : [];
  const out: MapService[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = prose(rec.id, 80);
    const name = prose(rec.name, 80);
    if (!id || !name) continue;
    const check = readCheck(rec.check);
    const also = readCheck(rec.also);
    const checkOk = check !== null && commandAllowed(check.bin, check.args) && sameCommand(STATUS_COMMANDS[id], check);
    const alsoOk = also === null || (commandAllowed(also.bin, also.args) && sameCommand(STATUS_COMMANDS[`${id}-plugin`], also));
    const blocked = (check !== null && !checkOk) || !alsoOk;
    out.push({
      id,
      name,
      login: prose(rec.login) ?? t("access.pending"),
      accountNote: prose(rec.accountNote) ?? t("access.pending"),
      permission: prose(rec.permission) ?? t("access.pending"),
      constraint: prose(rec.constraint) ?? "",
      roles: Array.isArray(rec.roles) ? rec.roles.filter((role): role is string => typeof role === "string" && role.length > 0 && role.length < 80 && !secretValue(role)) : [],
      noDispatch: rec.noDispatch === true,
      check: blocked ? null : check,
      also: blocked ? null : also,
      kind: rec.kind === "link" ? "link" : "login",
      blocked,
      unchecked: prose(rec.unchecked),
    });
  }
  return out;
}

export function accessProfiles(raw: unknown): AccessProfile[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as { daemon?: { agentProfiles?: unknown } }).daemon?.agentProfiles;
  if (!Array.isArray(list)) return [];
  const out: AccessProfile[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const name = prose(rec.name, 80);
    if (!name) continue;
    out.push({
      name,
      role: prose(rec.role, 40),
      provider: prose(rec.provider, 40) ?? "",
      model: prose(rec.model, 80),
      modeId: prose(rec.modeId, 40),
      pool: prose(rec.pool, 40),
      notes: typeof rec.notes === "string" && !secretValue(rec.notes) ? rec.notes : "",
    });
  }
  return out;
}

export function serviceNamesForRole(profileName: string, services: Array<Pick<MapService, "name" | "roles">>): string[] {
  return services.filter((service) => service.roles.includes(profileName)).map((service) => service.name);
}

export function roleLabel(role: string | null): string {
  if (!role) return t("access.role.none");
  const extra = Object.prototype.hasOwnProperty.call(EXTRA_ROLE, role) ? EXTRA_ROLE[role] : undefined;
  return dispatchRoleLabel(role) ?? (extra ? t(extra) : role);
}

/** `labels`: pool id → display name (shared/quota-adapters.ts poolNames(catalog, "label")). */
export function runsWhere(profile: Pick<AccessProfile, "provider" | "pool">, labels: Readonly<Record<string, string>> = {}): string {
  const vendor = VENDOR[profile.provider] ?? (profile.provider || t("access.where.unknownVendor"));
  if (!profile.pool) return t("access.where.noPool", { vendor });
  const label = poolLabel(profile.pool, labels);
  const saysQuota = tAll("access.where.quotaWord").some((word) => label.toLowerCase().includes(word.toLowerCase()));
  return t("access.where.pool", { vendor, label: saysQuota ? label : t("access.where.poolQuota", { label }) });
}

export interface AccessServiceView {
  id: string;
  name: string;
  login: string;
  account: string;
  accountLive: boolean;
  permission: string;
  constraint: string;
  roles: string[];
  noDispatch: boolean;
  state: "in" | "out" | "unknown";
  stateLabel: string;
  kind: "login" | "link";
  detail: string | null;
  scopeCount: number | null;
}

export interface AccessRoleView {
  name: string;
  roleLabel: string;
  where: string;
  mode: string;
  services: string[];
  limit: string;
}

export interface AccessView {
  checkedAt: string | null;
  checking: boolean;
  warning: string | null;
  services: AccessServiceView[];
  roles: AccessRoleView[];
}

function stateLabel(state: AccessServiceView["state"], kind: "login" | "link", detail: string | null): string {
  if (state === "unknown") {
    const checking = detail !== null && tAll("access.detail.checkingPrefix").some((prefix) => detail.startsWith(prefix));
    return t(checking ? "access.state.checking" : "access.state.unknown");
  }
  if (kind === "link") return t(state === "in" ? "access.state.linked" : "access.state.unlinked");
  return t(state === "in" ? "access.state.loggedIn" : "access.state.loggedOut");
}

function registeredAccount(note: string): string {
  return tAll("access.account.registeredMark").some((mark) => note.includes(mark)) ? note : t("access.account.registered", { note });
}

function withPlugin(hit: LiveCheck | undefined, plugin: LiveCheck | undefined): LiveCheck | undefined {
  if (!plugin?.detail) return hit;
  if (!hit) return { state: "unknown", account: null, scopeCount: null, detail: plugin.detail };
  const detail = [hit.detail, plugin.detail].filter((part): part is string => Boolean(part)).join(t("access.detail.join"));
  return { ...hit, detail: detail || null };
}

function clean(text: string, fallback: string): string {
  return secretValue(text) ? fallback : text;
}

export function buildAccessView(
  services: MapService[],
  profiles: AccessProfile[],
  live: Record<string, LiveCheck>,
  checkedAt: string | null,
  checking: boolean,
  warning: string | null,
  /** Pool id → display name (shared/quota-adapters.ts poolNames(catalog, "label")). */
  poolLabels: Readonly<Record<string, string>> = {},
): AccessView {
  return {
    checkedAt,
    checking,
    warning,
    services: services.map((service) => {
      const raw = service.check && !service.blocked ? live[service.id] : undefined;
      const plugin = service.id === "slack" ? live["slack-plugin"] : undefined;
      const hit = service.id === "slack" ? withPlugin(raw, plugin) : raw;
      const slow = Boolean(service.check && isSlowStatusCommand(service.check.bin, service.check.args));
      let state: AccessServiceView["state"] = hit?.state ?? "unknown";
      let detail = hit?.detail ?? null;
      if (service.blocked) {
        state = "unknown";
        detail = t("access.detail.blocked");
      } else if (!service.check) {
        state = "unknown";
        detail = service.unchecked ?? t("access.pending");
      } else if (!raw) {
        state = "unknown";
        const waiting = t(slow ? "access.detail.checkingMcp" : "access.detail.checking");
        detail = plugin?.detail ? `${waiting}${t("access.detail.join")}${plugin.detail}` : waiting;
      }
      const accountLive = state === "in" && Boolean(hit?.account);
      const account = state === "out"
        ? t(service.kind === "link" ? "access.state.unlinked" : "access.state.loggedOut")
        : hit?.account
          ? hit.account
          : state === "in"
            ? registeredAccount(service.accountNote)
            : service.accountNote;
      const safeDetail = detail && secretValue(detail) ? t("access.detail.tokenDropped") : detail;
      return {
        id: service.id,
        name: service.name,
        login: clean(service.login, t("access.pending")),
        account: clean(account, t("access.state.unknown")),
        accountLive,
        permission: clean(service.permission, t("access.pending")),
        constraint: clean(service.constraint, ""),
        roles: service.roles,
        noDispatch: service.noDispatch,
        state,
        stateLabel: stateLabel(state, service.kind, safeDetail),
        kind: service.kind,
        detail: safeDetail,
        scopeCount: hit?.scopeCount ?? null,
      };
    }),
    roles: profiles.map((profile) => ({
      name: profile.name,
      roleLabel: roleLabel(profile.role),
      where: runsWhere(profile, poolLabels),
      mode: modePlain(profile.modeId),
      services: serviceNamesForRole(profile.name, services),
      limit: restrictionSummary(profile.notes),
    })),
  };
}

const serviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  login: z.string(),
  account: z.string(),
  accountLive: z.boolean(),
  permission: z.string(),
  constraint: z.string(),
  roles: z.array(z.string()),
  noDispatch: z.boolean(),
  state: z.enum(["in", "out", "unknown"]),
  stateLabel: z.string(),
  kind: z.enum(["login", "link"]),
  detail: z.string().nullable(),
  scopeCount: z.number().nullable(),
});

const roleSchema = z.object({
  name: z.string(),
  roleLabel: z.string(),
  where: z.string(),
  mode: z.string(),
  services: z.array(z.string()),
  limit: z.string(),
});

export const accessRpc = defineRpc({
  name: "board.access",
  input: z.object({ refresh: z.boolean() }),
  output: z.object({
    checkedAt: z.string().nullable(),
    checking: z.boolean(),
    warning: z.string().nullable(),
    services: z.array(serviceSchema),
    roles: z.array(roleSchema),
  }),
});
