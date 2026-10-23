import type { parseDenylist } from "../shared/privacy-denylist.mjs";
export class SetupError extends Error {}
export interface PrivacyRule { id: string; pattern: RegExp; allow: RegExp[]; onlyPaths: RegExp[] | null; literal?: string | null }
export interface CompiledRules {
  ignore: RegExp[]; forbidden: RegExp[]; neverPublic: RegExp[]; forbiddenAllow: RegExp[];
  reviewedOccurrences: Array<{ path: string; rule: string; index: number; length: number; fingerprint: string }>;
  rules: PrivacyRule[]; outboundRules: PrivacyRule[]; privateIdentifierExceptions: Array<{ term: string; path: RegExp; function: string }>;
  publicOccurrenceLiterals: string[]; publicOccurrenceFingerprints: Set<string>; usedPublicOccurrences: Set<string>;
}
export interface PrivacyHit { path: string; line: number; rule: string; snippet: string }
export function compileRules(json: object): CompiledRules;
export function scanFile(path: string, text: string | null, compiled: CompiledRules, privateRules?: ReturnType<typeof parseDenylist>): PrivacyHit[];
export function observeReviewedOccurrences(path: string, text: string | null, compiled: CompiledRules): void;
export function occurrenceFingerprint(path: string, line: string | null, match: { index: number; 0: string }, literal: string): string;
