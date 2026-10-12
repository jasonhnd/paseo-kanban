/// <reference types="node" />
import type { PaseoApi } from "./paseo-api";
import { sampleQuota, type QuotaSample, type SamplingOptions } from "./quota-sampling";
import { USAGE_TIMEOUT_MS } from "./quota-timing";
import type { Json } from "./util";

export function quotaErrorText(error: unknown): string | null {
  if (!error) return null;
  let text = typeof error === "string" ? error : "";
  if (typeof error === "object") {
    const row = error as { code?: unknown; type?: unknown; message?: unknown };
    const parts = [row.code, row.type, row.message].filter((value): value is string => typeof value === "string");
    text = parts.join(": ");
  }
  // Keep only error categories evidenced by the reply, never its arbitrary message or credentials.
  const categories = [
    [/rate[_ -]?limit|\b429\b/i, "rate_limit"],
    [/(?:^|[\s_:-])(?:re-?)?auth(?:entication)?(?:failed|failure|expired|required|error)?(?:$|[\s_:-])|unauthorized|unauthenticated|not.logged|login.*lost|\b40[13]\b/i, "authentication"],
    [/quota/i, "quota"],
    [/timeout|timed.out/i, "timeout"],
    [/transport|connection/i, "transport"],
  ] as const;
  const matched = categories.filter(([pattern]) => pattern.test(text)).map(([, category]) => category);
  if (matched.length) return matched.join(": ");
  return "Provider usage failed";
}

export function providerUsageStatus(status: unknown): "available" | "unavailable" | "error" | null {
  return status === "available" || status === "unavailable" || status === "error" ? status : null;
}

function safeUsage(value: Json | null): Json | null {
  if (!value) return value;
  return { ...value, error: quotaErrorText(value.error), providers: (value.providers ?? []).map((provider: Json) => ({
    ...provider, status: providerUsageStatus(provider.status), error: quotaErrorText(provider.error),
  })) };
}

/** Shared by quota assembly and coupon checks. Paseo's own internal cache remains host-owned. */
export function readProviderQuota(paseo: PaseoApi, options: SamplingOptions<Json | null> = {}): Promise<QuotaSample<Json | null>> {
  return sampleQuota("paseo", () => new Promise<Json | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("providers.listUsage timed out")), USAGE_TIMEOUT_MS);
    Promise.resolve().then(() => paseo.providers.listUsage()).then(value => {
      clearTimeout(timer);
      try { resolve(safeUsage(value as Json | null)); }
      catch (error) { reject(new Error(quotaErrorText(error) ?? "Provider usage failed")); }
    },
      error => { clearTimeout(timer); reject(new Error(quotaErrorText(error) ?? "Provider usage failed")); });
  }), { ...options, errorOf: options.errorOf ?? (value => quotaErrorText(value?.error)) });
}
