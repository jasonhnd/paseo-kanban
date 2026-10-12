// fleet-quota/v1 contract package, client-safe half: payload schemas only (zod, no Node built-ins).
// Paseo bundles every shared/ file for the client too, so the parts that touch the file system live in
// server/contract. Both halves are shared verbatim by both plugins; edit them in one place and copy them
// with `scripts/sync-contract.mjs`.
export * from "./schema";
