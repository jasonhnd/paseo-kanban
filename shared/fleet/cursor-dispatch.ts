// Transport facts cannot be overridden by hand-edited family/pool labels.
interface CursorProfile { provider?: string; name?: string; model?: string | null; command?: unknown; args?: unknown; cliArgs?: unknown; extraArgs?: unknown; config?: unknown; featureValues?: unknown }
function channelValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === "string") return /(?:^|[\s/])cursor(?:-agent|-cli)?(?:$|[\s/])/.test(value.toLowerCase());
  if (Array.isArray(value)) return value.some(v => channelValue(v, depth + 1));
  if (value && typeof value === "object") return Object.values(value).some(v => channelValue(v, depth + 1));
  return false;
}
export function isCursorChannel(profile: CursorProfile): boolean {
  return /^cursor(?:$|[/:_-])/i.test(profile.provider ?? "") || /\bcursor\b/i.test(profile.name ?? "")
    || [profile.command, profile.args, profile.cliArgs, profile.extraArgs, profile.config, profile.featureValues].some(v => channelValue(v));
}
export function isCursorFirstParty(model: string | null | undefined): boolean {
  const id = (model?.trim().toLowerCase() ?? "").replace(/^cursor[/:]/, "");
  return /^(?:xai[/:-])?grok(?:$|[-.:])/.test(id)
    || /^(?:cursor[/:-])?composer(?:$|-(?:\d[\w.-]*|latest)$)/.test(id);
}
export function cursorPaidModel(profile: CursorProfile): boolean {
  return isCursorChannel(profile) && !isCursorFirstParty(profile.model);
}
