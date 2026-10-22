import type { Profile } from "./profiles";

const FAST_KEYS = ["fast", "fast_mode", "fastMode", "fast-mode"];
const TIER_KEYS = ["service_tier", "serviceTier", "service-tier"];
const CONFIG_KEYS = ["featureValues", "features", "config", "args", "cliArgs", "extraArgs", "command", "options", "launchArgs", "configOverrides"];
const enabled = (value: unknown): boolean => value === true || value === 1
  || (typeof value === "string" && /^(true|1|on|yes|enabled|fast|priority)$/i.test(value.trim()));
const quickTier = (value: unknown): boolean => typeof value === "string" && /^(priority|fast)$/i.test(value.trim());

/** Inspect speed settings, never profile labels, notes, model names or unrelated feature values. */
export function profileUsesFastMode(profile: Profile): boolean {
  const seen = new Set<object>();
  function visit(value: unknown): boolean {
    if (typeof value === "string") {
      // Config may be structured JSON, TOML assignments or shell/argv overrides.
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === "object") return visit(parsed);
      } catch { /* Non-JSON command/config text is checked below. */ }
      const text = value.replace(/["']/g, "");
      if (/(?:^|[\s=,:{[.])(?:--)?service[_-]?tier\s*(?:[=:]\s*|\s+)(?:priority|fast)(?=$|[\s,}\]])/i.test(text)) return true;
      if (/(?:^|[\s=,:{[.])(?:--)?fast(?:[_-]?mode)?\s*[=:]\s*(?:true|1|on|yes|enabled|fast|priority)(?=$|[\s,}\]])/i.test(text)) return true;
      for (const match of text.matchAll(/(?:^|\s)--fast(?:[_-]?mode)?(?=$|\s|=)(?:[=\s]+([^\s]+))?/gi)) {
        if (!match[1] || !/^(false|0|off|no|disabled)$/i.test(match[1])) return true;
      }
      return false;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      // Join argv to recognize split flags; also inspect structured config elements.
      return visit(value.filter(item => typeof item === "string").join(" ")) || value.some(item => typeof item === "object" && visit(item));
    }
    const record = value as Record<string, unknown>;
    return FAST_KEYS.some(key => enabled(record[key])) || TIER_KEYS.some(key => quickTier(record[key]))
      || CONFIG_KEYS.some(key => visit(record[key]));
  }
  return visit(profile);
}
