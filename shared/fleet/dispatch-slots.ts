// Stable ids for the shipped dispatch matrix. The file stores these ids; a readable
// config resolves each id to the live profile name before Kanban launches it.
// Display text comes from the catalog. A profile may set dispatchId when its name
// has no ASCII marker (Sonnet vs Opus).
import type { DispatchProfile } from "./dispatch";
import { t, type MessageKey } from "./i18n";

type Slot = {
  label: MessageKey;
  match: (profile: DispatchProfile) => boolean;
};

function serves(profile: DispatchProfile, role: string): boolean {
  return profile.candidateFor === role || profile.pausedCandidateFor === role;
}

function blob(profile: DispatchProfile): string {
  return `${profile.name} ${profile.model ?? ""} ${profile.provider ?? ""}`;
}

/** Prefer an ASCII marker in the name, then in the model. Both markers at once match nothing. */
function claudeMarker(profile: DispatchProfile): "sonnet" | "opus" | null {
  const pick = (text: string): "sonnet" | "opus" | null => {
    const sonnet = /sonnet/i.test(text);
    const opus = /opus/i.test(text);
    if (sonnet && !opus) return "sonnet";
    if (opus && !sonnet) return "opus";
    return null;
  };
  return pick(profile.name) ?? pick(`${profile.model ?? ""} ${profile.provider ?? ""}`);
}

function primary(role: string): (profile: DispatchProfile) => boolean {
  return (profile) => profile.role === role;
}

/** SuperGrok stand-ins. A Cursor profile that merely mentions Grok does not match. */
function isSuperGrok(profile: DispatchProfile): boolean {
  if (profile.provider === "cursor" || /cursor/i.test(profile.name)) return false;
  if (profile.provider === "grok") return true;
  return /grok/i.test(profile.name) || /grok/i.test(profile.model ?? "");
}

export const PROFILE_SLOTS: Readonly<Record<string, Slot>> = {
  executor: { label: "dispatch.role.executor", match: primary("executor") },
  "executor.gpt-6.1-sol": { label: "dispatch.slot.executorGpt", match: (profile) => serves(profile, "executor") && /gpt-6\.1/i.test(blob(profile)) },
  "executor.sonnet": { label: "dispatch.slot.executorSonnet", match: (profile) => serves(profile, "executor") && claudeMarker(profile) === "sonnet" },
  "executor.opus": { label: "dispatch.slot.executorOpus", match: (profile) => serves(profile, "executor") && claudeMarker(profile) === "opus" },
  reviewer: { label: "dispatch.role.reviewer", match: primary("reviewer") },
  "reviewer.gpt-6.1-sol": { label: "dispatch.slot.reviewerGpt", match: (profile) => serves(profile, "reviewer") && /gpt-6\.1/i.test(blob(profile)) },
  "reviewer.fable": { label: "dispatch.slot.reviewerFable", match: (profile) => serves(profile, "reviewer") && /fable/i.test(blob(profile)) },
  "reviewer.grok": { label: "dispatch.slot.reviewerGrok", match: (profile) => serves(profile, "reviewer") && isSuperGrok(profile) },
  reader: { label: "dispatch.role.reader", match: primary("reader") },
  "reader.gpt-6.1-sol": { label: "dispatch.slot.readerGpt", match: (profile) => serves(profile, "reader") && /gpt-6\.1/i.test(blob(profile)) },
  "reader.grok": { label: "dispatch.slot.readerGrok", match: (profile) => serves(profile, "reader") && isSuperGrok(profile) },
  decision: { label: "dispatch.role.decision", match: primary("decision") },
  "decision.gpt-6.1-sol": { label: "dispatch.slot.decisionGpt", match: (profile) => serves(profile, "decision") && /gpt-6\.1/i.test(blob(profile)) },
  "decision.grok": { label: "dispatch.slot.decisionGrok", match: (profile) => serves(profile, "decision") && isSuperGrok(profile) },
  batch: { label: "dispatch.role.batch", match: primary("batch") },
  "batch.gpt-6.1-sol": { label: "dispatch.slot.batchGpt", match: (profile) => serves(profile, "batch") && /gpt-6\.1/i.test(blob(profile)) },
  "batch.grok": { label: "dispatch.slot.batchGrok", match: (profile) => serves(profile, "batch") && isSuperGrok(profile) },
  "ops.vercel": { label: "dispatch.role.opsVercel", match: primary("ops_vercel") },
  "ops.cloudflare": { label: "dispatch.role.opsCloudflare", match: primary("ops_cloudflare") },
  "ops.github": { label: "dispatch.role.opsGithub", match: primary("ops_github") },
  "ops.notion": { label: "dispatch.role.opsNotion", match: primary("ops_notion") },
};

/** Live profile for a matrix token: exact name, explicit dispatchId, then a slot rule. */
export function resolveProfileToken(token: string, profiles: readonly DispatchProfile[]): DispatchProfile | null {
  const named = profiles.find((profile) => profile.name === token || profile.dispatchId === token);
  if (named) return named;
  const slot = PROFILE_SLOTS[token];
  return slot ? profiles.find((profile) => slot.match(profile)) ?? null : null;
}

/** Catalog label for a slot id. Null when the token is a live profile name. */
export function dispatchSlotLabel(token: string): string | null {
  const slot = PROFILE_SLOTS[token];
  return slot ? t(slot.label) : null;
}
