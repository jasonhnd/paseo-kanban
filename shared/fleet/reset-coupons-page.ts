import { type CouponKind, DAY_MS, tokyoParts, tokyoInstant } from "./reset-coupons-core";
import { type AdapterId, CODEX_CLI, CURSOR_API, GROK_CLI } from "./quota-adapters";
import { t } from "./i18n";

export interface PageRead {
  status: "coupon" | "none" | "unreadable";
  count: number;
  kind: CouponKind;
  expiresAt: string | null;
  /** One short line from the resets paragraph. Never the whole page. */
  excerpt: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function excerptOf(section: string): string {
  return section.replace(/\s+/g, " ").trim().slice(0, 120);
}

function sectionOf(adapter: AdapterId, text: string): string | null {
  const flat = text.replace(/\r/g, "");
  // "Resets Sep 30" is the quota clock, not the coupon block. The coupon block is its own heading,
  // or Codex's "Usage limit resets".
  const marker = adapter === CODEX_CLI ? /usage limit resets/i : /usage limit resets|(?:^|\n)\s*Resets\s*(?:\n|$)/i;
  const at = marker.exec(flat);
  if (!at || at.index === undefined) return null;
  const rest = flat.slice(at.index);
  const stop = rest.search(/\n(?:usage credits|cloud session|extra usage credits|on-demand usage|buy credits)\b/i);
  const chunk = stop > 40 ? rest.slice(0, stop) : rest.slice(0, 800);
  return chunk;
}

function countIn(section: string): number | null {
  if (/no (?:extra |available )?(?:resets|reset credits)|0 resets|you (?:don't|do not) have|none available|no reset credits/i.test(section)) return 0;
  const buttons = section.match(/reset for free|full reset/gi);
  if (buttons && buttons.length > 0) return buttons.length;
  // "2 resets" counts. "Opus 5.5 Reset" does not: the digit sits in a version.
  const numbered = /(?:^|[^\d.])(\d+)\s+(?:free\s+)?resets?\b/i.exec(section);
  if (numbered) return Number(numbered[1]);
  if (/\buse reset\b/i.test(section)) return 1;
  return null;
}

function kindIn(section: string): CouponKind {
  if (/full reset/i.test(section)) return "full";
  if (/5[\s-]*hour|session/i.test(section) && /reset/i.test(section)) return "session";
  if (/weekly/i.test(section) && /reset for free|full reset|use reset/i.test(section)) return "weekly";
  return "unknown";
}

function expiryIn(section: string, now: number): string | null {
  const named = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/i.exec(section);
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const day = Number(named[2]);
    const year = named[3] ? Number(named[3]) : yearFor(month, day, now);
    if (!month || day < 1 || day > 31) return null;
    return new Date(tokyoInstant(year, month, day, 23, 59, 59)).toISOString();
  }
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(section);
  if (iso) return new Date(tokyoInstant(Number(iso[1]), Number(iso[2]), Number(iso[3]), 23, 59, 59)).toISOString();
  return null;
}

function yearFor(month: number, day: number, now: number): number {
  const p = tokyoParts(now);
  const thisYear = tokyoInstant(p.y, month, day, 23, 59, 59);
  if (thisYear < now - 60 * DAY_MS) return p.y + 1;
  return p.y;
}

/**
 * Read a count, a kind, and an expiry out of the resets paragraph.
 * A missing paragraph is `unreadable` (keep the previous value). A paragraph that
 * says there is nothing is `none`. The excerpt is one line, not the page.
 */
function loadedWithoutCoupon(adapter: AdapterId, text: string): boolean {
  if (/reset for free|full reset|\buse reset\b|usage limit resets/i.test(text)) return false;
  if (adapter === GROK_CLI) return /extra usage credits/i.test(text);
  if (adapter === CURSOR_API) return /included in ultra|on-demand/i.test(text);
  return false;
}

/** The vendor's usage page of a plan read by `adapter` (shared/quota-adapters.ts). */
export function parseResetPage(adapter: AdapterId, text: string, now: number): PageRead {
  const section = sectionOf(adapter, text);
  if (section === null) {
    if (loadedWithoutCoupon(adapter, text)) return { status: "none", count: 0, kind: "unknown", expiresAt: null, excerpt: "" };
    return { status: "unreadable", count: 0, kind: "unknown", expiresAt: null, excerpt: "" };
  }
  const count = countIn(section);
  if (count === null) return { status: "unreadable", count: 0, kind: "unknown", expiresAt: null, excerpt: excerptOf(section) };
  if (count <= 0) return { status: "none", count: 0, kind: "unknown", expiresAt: null, excerpt: excerptOf(section) };
  return {
    status: "coupon",
    count,
    kind: kindIn(section),
    expiresAt: expiryIn(section, now),
    excerpt: excerptOf(section),
  };
}

const COUPON_KEY = /reset.?coupons?|extra.?resets?|resets?.?remaining|available.?resets?|reset.?credits?|num.?resets?|coupon.?count|free.?resets?/i;

function kindFromKey(key: string): CouponKind {
  if (/full/i.test(key)) return "full";
  if (/session|five|5.?hour/i.test(key)) return "session";
  if (/week/i.test(key)) return "weekly";
  return "unknown";
}

function expiryFrom(value: Record<string, unknown>, now: number): string | null {
  for (const [key, child] of Object.entries(value)) {
    if (!/expir|until|valid/i.test(key) || typeof child !== "string") continue;
    const parsed = Date.parse(child);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    const viaPage = expiryIn(child, now);
    if (viaPage) return viaPage;
  }
  return null;
}

export interface ProviderCoupon {
  count: number;
  kind: CouponKind;
  expiresAt: string | null;
  excerpt: string;
}

/**
 * Look through one provider usage object for a reset-coupon field.
 * Returns null when Paseo did not include one, so the caller can ask the CLI instead.
 * Does not copy the object.
 */
export function findCouponFields(value: unknown, now: number): ProviderCoupon | null {
  const found = walkCoupon(value, now, 0);
  return found;
}

function walkCoupon(value: unknown, now: number, depth: number): ProviderCoupon | null {
  if (depth > 5 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = walkCoupon(item, now, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (!COUPON_KEY.test(key) || /resets?At|resets?_at/i.test(key)) continue;
    if (typeof child === "number" && Number.isFinite(child) && child >= 0) {
      return {
        count: child,
        kind: kindFromKey(key),
        expiresAt: expiryFrom(record, now),
        excerpt: t("coupons.page.excerpt", { key, count: child }).slice(0, 120),
      };
    }
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const bag = child as Record<string, unknown>;
      const count = typeof bag.count === "number" ? bag.count : typeof bag.remaining === "number" ? bag.remaining : null;
      if (count !== null && Number.isFinite(count) && count >= 0) {
        return {
          count,
          kind: kindFromKey(key),
          expiresAt: expiryFrom(bag, now),
          excerpt: t("coupons.page.excerpt", { key, count }).slice(0, 120),
        };
      }
    }
  }
  for (const child of Object.values(record)) {
    const found = walkCoupon(child, now, depth + 1);
    if (found) return found;
  }
  return null;
}
