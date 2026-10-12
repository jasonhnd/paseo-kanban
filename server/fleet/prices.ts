/// <reference types="node" />
// API list prices (USD per 1M tokens) from the public models.dev catalog, cached on disk for a day.
// plans.json can override any model with "prices": { "<model>": { input, output, cacheRead, cacheWrite } }.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type Json, readJson, STATE_DIR, writeJson } from "./util";
import { CURSOR_PROVIDER, GROK_PROVIDER } from "../../shared/fleet/quota-adapters";
import { t } from "../../shared/fleet/i18n";

const CATALOG_URL = "https://models.dev/api.json";
const CACHE = join(STATE_DIR, "prices-cache.json");
const DAY = 24 * 60 * 60_000;

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Price above the long-context threshold, when the vendor charges more. */
  long: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  longAbove: number | null;
  catalogId: string;
}

/**
 * Provider id -> catalog vendor. Cursor resells other vendors' models.
 * The antigravity adapter routes models to the google price catalog.
 */
const VENDOR: Record<string, string> = { claude: "anthropic", codex: "openai", grok: "xai", cursor: "xai", antigravity: "google" };

interface CatalogCache { fetchedAt: string; vendors: Record<string, Record<string, Json>> }

let loaded: { at: number; data: CatalogCache | null } = { at: 0, data: null };

async function catalog(): Promise<CatalogCache | null> {
  if (loaded.data && Date.now() - loaded.at < 60 * 60_000) return loaded.data;
  const st = await stat(CACHE).catch(() => null);
  let data = await readJson<CatalogCache | null>(CACHE, null);
  if (!st || Date.now() - st.mtimeMs > DAY || !data) {
    try {
      const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30_000) as never });
      const all = (await res.json()) as Json;
      const vendors: CatalogCache["vendors"] = {};
      for (const v of new Set(Object.values(VENDOR))) {
        vendors[v] = Object.fromEntries(
          Object.entries((all[v]?.models ?? {}) as Record<string, Json>).map(([id, m]) => [id, { cost: m.cost ?? null }]),
        );
      }
      data = { fetchedAt: new Date().toISOString(), vendors };
      await writeJson(CACHE, data);
    } catch (e) {
      console.error("[afc] price catalog fetch failed:", String(e));
    }
  }
  loaded = { at: Date.now(), data };
  return data;
}

export async function pricesFetchedAt(): Promise<string | null> {
  return (await catalog())?.fetchedAt ?? null;
}

/** Strip transport suffixes so "grok-4.7-build", "claude-sonnet-5[1m]", "gemini-3.8-flash-high" match the catalog. */
export function normalizeModel(model: string): string {
  let m = model.toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/^.*[:/]/, "");
  m = m.replace(/-build(-fast)?$/, "").replace(/-(high|medium|low|thinking)$/, "");
  if (m === "gemini-pro-agent") m = "gemini-3.1-pro";
  return m;
}

function toPrice(id: string, cost: Json | null): Price | null {
  if (!cost || typeof cost.input !== "number") return null;
  const long = cost.context_over_200k ?? null;
  const tier = Array.isArray(cost.tiers) ? cost.tiers.find((t: Json) => t?.tier?.type === "context") : null;
  const pick = (c: Json) => ({ input: c.input ?? 0, output: c.output ?? 0, cacheRead: c.cache_read ?? c.input ?? 0, cacheWrite: c.cache_write ?? c.input ?? 0 });
  return {
    ...pick(cost),
    long: long ? pick(long) : null,
    longAbove: tier?.tier?.size ?? (long ? 200_000 : null),
    catalogId: id,
  };
}

/** xAI bills the "-fast" variants at twice the standard rate; the catalog only lists the standard model. */
const FAST_MULTIPLIER = 2;
/** Providers that serve xAI's "-fast" variants: Grok itself, and Cursor (which routes Grok models). */
const FAST_PRICED_PROVIDERS = new Set<string>([GROK_PROVIDER, CURSOR_PROVIDER]);

function scale(p: Price, k: number): Price {
  const m = (r: { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({ input: r.input * k, output: r.output * k, cacheRead: r.cacheRead * k, cacheWrite: r.cacheWrite * k });
  return { ...p, ...m(p), long: p.long ? m(p.long) : null, catalogId: t("prices.fastCatalogId", { id: p.catalogId, k }) };
}

export async function priceFor(provider: string, model: string, overrides: Record<string, Json>): Promise<Price | null> {
  const base = await basePrice(provider, model, overrides);
  const fast = /-fast$/.test(model.replace(/\[[^\]]*\]$/, "")) && FAST_PRICED_PROVIDERS.has(provider);
  return base && fast ? scale(base, FAST_MULTIPLIER) : base;
}

async function basePrice(provider: string, model: string, overrides: Record<string, Json>): Promise<Price | null> {
  const norm = normalizeModel(model);
  const o = overrides[model] ?? overrides[norm];
  if (o) return { input: o.input ?? 0, output: o.output ?? 0, cacheRead: o.cacheRead ?? o.input ?? 0, cacheWrite: o.cacheWrite ?? o.input ?? 0, long: null, longAbove: null, catalogId: "plans.json" };
  const vendor = VENDOR[provider];
  const models = vendor ? (await catalog())?.vendors[vendor] : undefined;
  if (!models) return null;
  if (models[norm]) return toPrice(norm, models[norm].cost);
  // Closest catalog id: exact prefix either way, preferring the shortest extra suffix ("-preview", dated ids).
  const candidates = Object.keys(models)
    .filter((id) => id.startsWith(norm) || norm.startsWith(id))
    .sort((a, b) => Math.abs(a.length - norm.length) - Math.abs(b.length - norm.length));
  for (const id of candidates) {
    const p = toPrice(id, models[id].cost);
    if (p) return p;
  }
  return null;
}
