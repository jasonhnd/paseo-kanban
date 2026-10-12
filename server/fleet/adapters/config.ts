/// <reference types="node" />
import { bannedProviderTerms } from "../../../shared/fleet/provider-policy";
// Optional adapter switches, from `afc.config.json` in the data directory:
//   { "adapters": { "cursor-api": true, "keychain": true, "antigravity-cli": false } }
// cursor-api: Cursor's official usage API, the cursor-agent screen and the Cursor login watch.
// keychain:   the once-a-minute macOS keychain presence probe.
// antigravity-cli: local agy /usage display. No state file counts as in-use; only a literal true starts it.
// A switch that is not set is off, with one exception for installs that predate the switches: an adapter whose
// state file is already in the data directory (it was running before) stays on until the switch is written.
// Only a literal true or false counts. A file that cannot be read is treated as missing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { leaderThresholds, type LeaderThresholds } from "../../../shared/fleet/leader-usage";
import { hiddenPlanTerms } from "../../../shared/fleet/hidden-plans";
import { opsProject } from "../../../shared/fleet/ops-project";
import { ADAPTERS_OFF, ANTIGRAVITY_CLI, type AdapterSwitches, CURSOR_API, KEYCHAIN, OPTIONAL_ADAPTERS, type OptionalAdapter } from "../../../shared/fleet/quota-adapters";
import { STATE_DIR } from "../util";

export const AFC_CONFIG_FILE = "afc.config.json";

/** State files an adapter writes while it runs. Present means "this install already used it". */
export const IN_USE_MARKERS: Record<OptionalAdapter, readonly string[]> = {
  [CURSOR_API]: ["cursor-usage.json", "cursor-login-state.json"],
  [KEYCHAIN]: ["keychain-probe-state.json"],
  // Empty on purpose. A cache or usage file must not turn the reader on the way Cursor's old state files do.
  [ANTIGRAVITY_CLI]: [],
};

/** Pure: explicit switches win; an unset one follows `inUse`. */
export function resolveSwitches(raw: unknown, inUse: (adapter: OptionalAdapter) => boolean): AdapterSwitches {
  const adapters = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { adapters?: unknown }).adapters : undefined;
  const set = adapters && typeof adapters === "object" && !Array.isArray(adapters) ? (adapters as Record<string, unknown>) : {};
  const out: AdapterSwitches = { ...ADAPTERS_OFF };
  for (const adapter of OPTIONAL_ADAPTERS) {
    const value = set[adapter];
    out[adapter] = typeof value === "boolean" ? value : inUse(adapter);
  }
  return out;
}

function readConfig(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, AFC_CONFIG_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** Switches for this data directory. A few file checks, no command or daemon call. */
export function adapterSwitches(dir: string = STATE_DIR): AdapterSwitches {
  return resolveSwitches(readConfig(dir), (adapter) => IN_USE_MARKERS[adapter].some((name) => existsSync(join(dir, name))));
}

export function adapterOn(adapter: OptionalAdapter, dir: string = STATE_DIR): boolean {
  return adapterSwitches(dir)[adapter];
}

/** Hide list for this data directory. Missing or invalid means show every plan. */
export function readHiddenPlans(dir: string = STATE_DIR): string[] {
  return hiddenPlanTerms(readConfig(dir));
}

/** Provider/company exclusion list. Missing, invalid or unreadable means allow all. */
export function readBannedProviders(dir: string = STATE_DIR): string[] {
  return bannedProviderTerms(readConfig(dir));
}

/** Context thresholds for homepage rows and read-only inspections. */
export function readLeaderThresholds(dir: string = STATE_DIR): LeaderThresholds {
  return leaderThresholds(readConfig(dir));
}

/** The board project receiving AFC's own notices and newly created default decisions. */
export function readOpsProject(dir: string = STATE_DIR): string {
  return opsProject(readConfig(dir));
}
