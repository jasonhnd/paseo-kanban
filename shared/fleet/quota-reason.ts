// Reading pool reasons and coupon sentences in any language: the server may have written them in another
// language than the panel shows now (stored snapshots, older installs). Pure, no node: imports.
import { type MessageKey, tAll } from "./i18n";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One regex matching `key` in every language. Spaces in the text match any run of whitespace. */
export function anyLanguage(key: MessageKey, flags = ""): RegExp {
  const alts = tAll(key).map((text) => escapeRegex(text).replace(/ +/g, "\\s*"));
  return new RegExp(`(?:${alts.join("|")})`, flags);
}

const NUMBER_SLOT = "\u0000N\u0000";
const NUMBER_GROUP = "(\\d+(?:\\.\\d+)?)";

/** Regex over a `{n}` template in every language; each language's number is its own capture group. */
function numberPattern(key: MessageKey, lookbehind?: MessageKey): RegExp {
  const before = lookbehind ? `(?<!${tAll(lookbehind).map(escapeRegex).join("|")})` : "";
  const alts = tAll(key, { n: NUMBER_SLOT }).map((text) =>
    escapeRegex(text).replace(/ +/g, "\\s*").replace(escapeRegex(NUMBER_SLOT), NUMBER_GROUP));
  return new RegExp(`${before}(?:${alts.join("|")})`, "g");
}

/** Replace every `{n}` template of `key` (any language) in `text`; `fn` gets the number as written. */
export function replaceNumbers(text: string, key: MessageKey, fn: (n: string) => string, lookbehind?: MessageKey): string {
  return text.replace(numberPattern(key, lookbehind), (...args: unknown[]) => {
    const groups = args.slice(1, -2);
    const n = groups.find((group): group is string => typeof group === "string");
    return n === undefined ? String(args[0]) : fn(n);
  });
}

/** The pool's reason says it does not take work at all (plans.json note or a closed plan). Any language. */
export function reasonSaysNoDispatch(reason: string): boolean {
  return anyLanguage("quota.reason.noDispatchMarker").test(reason)
    || anyLanguage("quota.reason.notReliedMarker").test(reason)
    || anyLanguage("quota.reason.planNotUsedMarker").test(reason);
}

/** The pool's reason says it waits for the 5-hour window to refresh. Any language. */
export function reasonWaitsForWindow(reason: string): boolean {
  return anyLanguage("quota.reason.waitWindowMarker").test(reason);
}
