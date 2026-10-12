/**
 * Regex building blocks for reading decision text and stored notes in any language.
 * Words come from the catalogs (all languages at once, via tAll), so data written by an older
 * Chinese install and new English data both match. Pure; no I/O.
 */
import { type MessageKey, type MessageVars, tAll } from "./i18n";

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Full-width forms of ASCII punctuation (U+FF01-FF5E is ASCII + 0xFEE0). CJK text writes the full-width colon for `:`
 * and so on; parsers accept both forms whatever the interface language is.
 */
export function fullWidth(ascii: string): string {
  return [...ascii].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join("");
}

/** ASCII punctuation plus its full-width forms, ready for a regex character class. */
export function punct(ascii: string): string {
  return escapeClass(ascii + fullWidth(ascii));
}

export function escapeClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, "\\$&");
}

/** Parser word lists: a catalog value may hold alternatives separated by `|`. Longest first. */
export function catalogWords(key: MessageKey): string[] {
  const words = tAll(key).flatMap((value) => value.split("|")).map((word) => word.trim()).filter(Boolean);
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

/** `(?:word|word…)` over every language's spelling of `key`. */
export function anyWord(key: MessageKey): string {
  return `(?:${catalogWords(key).map(escapeRegExp).join("|")})`;
}

/** Every distinct character of a catalog value in any language, for a character class. */
export function catalogChars(key: MessageKey): string {
  return escapeClass([...new Set(tAll(key).join(""))].join(""));
}

/**
 * A regex source matching a catalog template in any language: literal text escaped, whitespace runs
 * loose (`\s*`), `{name}` replaced by `patterns[name]`. With `upTo`, the template is cut right after
 * that placeholder (a prefix match).
 */
export function templatePattern(key: MessageKey, patterns: Readonly<Record<string, string>>, upTo?: string): string {
  const vars: MessageVars = Object.fromEntries(Object.keys(patterns).map((name) => [name, `{${name}}`]));
  const sources = tAll(key, vars).map((template) => {
    const cut = upTo ? template.indexOf(`{${upTo}}`) : -1;
    const text = cut >= 0 ? template.slice(0, cut + upTo!.length + 2) : template;
    return text.split(/(\{\w+\})/).map((part) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      if (name && name in patterns) return patterns[name];
      return part.split(/\s+/).map(escapeRegExp).join("\\s*");
    }).join("");
  });
  return `(?:${[...new Set(sources)].join("|")})`;
}

/** Memoize a value built from the catalogs. Catalogs never change at runtime, so one build is enough. */
export function lazy<T>(build: () => T): () => T {
  let value: T | undefined;
  let built = false;
  return () => {
    if (!built) {
      value = build();
      built = true;
    }
    return value as T;
  };
}
