import type { AccessServiceView, AccessView } from "./access";
import { t, tAll } from "./i18n";

function labelIs(label: string, key: "access.state.checking" | "access.state.unknown"): boolean {
  return tAll(key).includes(label);
}

export function accessTone(state: "in" | "out" | "unknown"): "green" | "red" | "yellow" {
  if (state === "in") return "green";
  if (state === "out") return "red";
  return "yellow";
}

export function accessRefetchMs(view: Pick<AccessView, "checking" | "services"> | undefined): number {
  if (!view || view.checking || view.services.some((row) => labelIs(row.stateLabel, "access.state.checking"))) return 3_000;
  return 60_000;
}

export function accessCounts(services: readonly Pick<AccessServiceView, "state" | "kind" | "stateLabel">[]): {
  loggedIn: number;
  linked: number;
  unknown: number;
} {
  return {
    loggedIn: services.filter((row) => row.state === "in" && row.kind === "login").length,
    linked: services.filter((row) => row.state === "in" && row.kind === "link").length,
    unknown: services.filter((row) => labelIs(row.stateLabel, "access.state.unknown")).length,
  };
}

export function serviceFoldSummary(total: number, counts: { loggedIn: number; linked: number; unknown: number }): string {
  const parts = [t("access.view.foldCount", { count: total }), t("access.view.foldLoggedIn", { count: counts.loggedIn }), t("access.view.foldLinked", { count: counts.linked })];
  if (counts.unknown > 0) parts.push(t("access.view.foldUnknown", { count: counts.unknown }));
  return parts.join(" · ");
}

export function roleFoldSummary(count: number): string {
  return t("access.view.profiles", { count });
}

export function permissionLine(permission: string, scopeCount: number | null): string {
  if (scopeCount === null) return t("access.view.permission", { permission });
  return t("access.view.permissionScopes", { permission, count: scopeCount });
}

export function accountLine(accountLive: boolean, account: string): string {
  return t(accountLive ? "access.view.account" : "access.view.accountRegistered", { account });
}

export function roleUsers(roles: readonly string[]): string {
  return roles.length > 0 ? roles.join(t("access.listJoin")) : t("access.view.noUsers");
}

export function roleServices(services: readonly string[]): string {
  return services.length > 0 ? services.join(t("access.listJoin")) : t("access.view.noServices");
}
