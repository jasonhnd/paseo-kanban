import { createHash } from "node:crypto";
const CONTEXT = 40;
export class SetupError extends Error {}

const regex = (source, flags = "") => new RegExp(source, flags);

/** Compile the generic rules file. */
export function compileRules(json) {
  const list = (items) => (items ?? []).map((source) => regex(source));
  const contentRules = rules => (rules ?? []).map(rule => ({
    id: rule.id, pattern: regex(rule.pattern, rule.caseInsensitive ? "gi" : "g"), allow: list(rule.allow),
    onlyPaths: rule.onlyPaths ? list(rule.onlyPaths) : null,
  }));
  return {
    // Reviewed public-name collisions are bound to the exact match, path and line.
    // These fingerprints never exempt another rule, another match or a changed line.
    publicOccurrenceLiterals: (json.publicOccurrenceLiterals ?? []).map(value => {
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new SetupError("invalid public occurrence literal");
      return value;
    }),
    usedPublicOccurrences: new Set(),
    reviewedOccurrences: (json.reviewedOccurrences ?? []).map(item => {
      if (typeof item.path !== "string" || !item.path || item.path.startsWith("/")
          || item.path.split("/").some(part => !part || part === "." || part === "..")
          || typeof item.rule !== "string" || !item.rule
          || !Number.isSafeInteger(item.index) || item.index < 0
          || !Number.isSafeInteger(item.length) || item.length <= 0
          || typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.fingerprint)) throw new SetupError("invalid reviewed occurrence");
      return { ...item };
    }),
    publicOccurrenceFingerprints: new Set((json.publicOccurrenceFingerprints ?? []).map(value => {
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new SetupError("invalid public occurrence fingerprint");
      return value;
    })),
    privateIdentifierExceptions: (json.privateIdentifierExceptions ?? []).map(item => {
      if (!Array.isArray(item.termParts) || !item.termParts.length
          || item.termParts.some(part => typeof part !== "string" || !part)
          || typeof item.path !== "string" || !item.path.startsWith("^") || !item.path.endsWith("$")
          || typeof item.function !== "string" || !item.function) throw new SetupError("invalid private identifier exception");
      const term = item.termParts.join("");
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(term)) throw new SetupError("identifier exception needs an exact identifier");
      return { term, path: regex(item.path), function: item.function };
    }),
    ignore: list(json.ignorePaths),
    forbidden: list(json.forbiddenPaths?.patterns),
    neverPublic: list(json.neverPublicPaths),
    forbiddenAllow: list(json.forbiddenPaths?.allow),
    rules: contentRules(json.rules),
    outboundRules: contentRules(json.outboundRules),
  };
}


export const anyMatch = (patterns, text) => patterns.some((pattern) => pattern.test(text));

/** The line around a hit, with the hit itself masked. */
export function masked(line, index, length) {
  const start = Math.max(0, index - CONTEXT);
  const end = Math.min(line.length, index + length + CONTEXT);
  return `${line.slice(start, index)}***${line.slice(index + length, end)}`.trim();
}

/** True when a path name alone is refused (real data files, private folders). */
export function isForbiddenPath(path, compiled) {
  return anyMatch(compiled.neverPublic ?? [], path)
    || (anyMatch(compiled.forbidden, path) && !anyMatch(compiled.forbiddenAllow, path));
}

export function occurrenceFingerprint(path, line, match, literal) {
  return createHash("sha256").update(JSON.stringify([path, line, match.index, match[0], literal.toLowerCase()])).digest("hex");
}

function reviewedPublicMatch(compiled, path, line, match, rule) {
  if (typeof rule.literal !== "string") return false; // Regex rules are never exempted.
  const fingerprint = occurrenceFingerprint(path, line, match, rule.literal);
  if (!compiled.publicOccurrenceFingerprints?.has(fingerprint)) return false;
  compiled.usedPublicOccurrences.add(fingerprint);
  return true;
}

function reviewedOccurrence(compiled, path, line, match, rule) {
  const approval = compiled.reviewedOccurrences?.find(item => item.path === path && item.rule === rule.id
    && item.index === match.index && item.length === match[0].length
    && item.fingerprint === occurrenceFingerprint(path, line, match, rule.id));
  if (!approval) return false;
  compiled.usedPublicOccurrences.add(approval.fingerprint);
  return true;
}

/** Freshness can inspect approved spans without loading or publishing private terms.
 * This only records presence; scanFile still requires the actual rule match to approve a hit. */
export function observeReviewedOccurrences(path, text, compiled) {
  const lines = text === null ? [] : text.split("\n");
  for (const item of compiled.reviewedOccurrences ?? []) {
    if (item.path !== path) continue;
    for (const line of [null, ...lines]) {
      const value = line === null ? path : line;
      if (item.index + item.length > value.length) continue;
      reviewedOccurrence(compiled, path, line, { index: item.index, 0: value.slice(item.index, item.index + item.length) }, { id: item.rule });
    }
  }
}

export function unusedPublicOccurrences(compiled) {
  return [...compiled.publicOccurrenceFingerprints, ...(compiled.reviewedOccurrences ?? []).map(item => item.fingerprint)]
    .filter(value => !compiled.usedPublicOccurrences.has(value));
}

/** Hits for one file. `text` is null for binary files, which are judged by path only. */
export function scanFile(path, text, compiled, privateRules = [], resolveIdentifiers = () => new Set()) {
  const hits = [];
  // A file name can leak as much as its content, so private terms are checked on every path, ignored ones too.
  for (const rule of privateRules) {
    for (const match of path.matchAll(rule.pattern)) {
      if (!reviewedPublicMatch(compiled, path, null, match, rule) && !reviewedOccurrence(compiled, path, null, match, rule)) hits.push({ path, line: 0, rule: rule.id, snippet: masked(path, match.index, match[0].length) });
    }
  }
  if (isForbiddenPath(path, compiled)) hits.push({ path, line: 0, rule: "forbidden-path", snippet: path });
  // Ignoring file content never exempts a prohibited path, including images and other binary files.
  if (anyMatch(compiled.ignore, path)) return hits;
  if (text === null) return hits;
  const identifiers = resolveIdentifiers(path, text, compiled.privateIdentifierExceptions ?? [], privateRules);
  const rules = [...compiled.rules.filter((rule) => !rule.onlyPaths || anyMatch(rule.onlyPaths, path)), ...privateRules];
  let offset = 0;
  text.split("\n").forEach((line, index) => {
    for (const rule of rules) {
      for (const match of line.matchAll(rule.pattern)) {
        if (anyMatch(rule.allow, match[0])) continue;
        if (reviewedOccurrence(compiled, path, line, match, rule)) continue;
        if (rule.id === "private" && reviewedPublicMatch(compiled, path, line, match, rule)) continue;
        if (rule.id === "private" && identifiers.has(`${offset + match.index}:${match[0].length}`)) continue;
        hits.push({ path, line: index + 1, rule: rule.id, snippet: masked(line, match.index, match[0].length) });
      }
    }
    offset += line.length + 1;
  });
  return hits;
}
