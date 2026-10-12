import type { PaseoApi } from "./paseo-api";
import { buildRolePreview, type Discovery, type RoleChoice, type RolePreview } from "../../shared/fleet/profile-bootstrap";
import type { Language } from "../../shared/fleet/i18n";

type Host = Pick<PaseoApi, "providers">;
const TIMEOUT_MS = 5_000;

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

/** Only public provider catalogs are read. No config.get, diagnostics, login probes, or agent creation. */
export async function discoverRoles(host: Host, timeoutMs = TIMEOUT_MS): Promise<Discovery> {
  try {
    const [snapshot, availability] = await bounded(Promise.all([
      host.providers.waitForReady({ timeoutMs }), host.providers.listAvailable(),
    ]), timeoutMs);
    if (availability.error) return { status: "unknown", providers: [] };
    return {
      status: "ready",
      providers: snapshot.entries.map(row => {
        const available = availability.providers.find(item => item.provider === row.provider);
        const state = !row.enabled || available?.available === false || row.status === "unavailable" || row.status === "error"
          ? "unavailable" : row.status === "ready" && available?.available === true ? "discoverable" : "unknown";
        return {
          provider: row.provider, enabled: row.enabled, state,
          models: state === "discoverable" ? (row.models ?? []).filter(model => model.isSelectable !== false).map(model => ({
            id: model.id, label: model.label,
            thinking: (model.thinkingOptions ?? []).map(option => ({ id: option.id, label: option.label })),
          })) : [],
          modes: state === "discoverable" ? (row.modes ?? []).map(mode => ({ id: mode.id, label: mode.label })) : [],
        };
      }),
    };
  } catch (error) {
    // Raw provider errors may contain paths or credential material; return a fixed status.
    return { status: error instanceof Error && error.message === "timeout" ? "timeout" : "unknown", providers: [] };
  }
}

/** Re-discover on preview so a removed or disabled model cannot survive a stale client selection. */
export async function previewRoles(host: Host, input: { executor: RoleChoice; reviewer?: RoleChoice; language: Language }): Promise<RolePreview> {
  const discovery = await discoverRoles(host);
  if (discovery.status !== "ready") return { status: "unavailable", issue: discovery.status, review: "manual", profiles: [] };
  return buildRolePreview(discovery, input.executor, input.reviewer, input.language);
}
