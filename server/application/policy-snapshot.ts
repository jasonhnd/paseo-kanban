/// <reference types="node" />
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PolicySnapshot, type PolicySnapshot as Snapshot } from "../../shared/fleet/policy-snapshot";
import { dataDir, paseoConfigPath } from "../paths";
import { withConfigLock } from "../config-lock";

export type PolicyRead = { state: "ok"; snapshot: Readonly<Snapshot> }
  | { state: "absent" | "invalid"; reason: string };
export const policySnapshotPath = () => join(dataDir(), "fleet", "policy-snapshot.json");

function bytes(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
}

/** Hash policy inputs, never transport credentials. Every reader revalidates the current revision. */
export function policyDigest(): string {
  const config = JSON.parse(bytes(paseoConfigPath()));
  const profiles = config?.daemon?.agentProfiles;
  if (!Array.isArray(profiles)) throw new Error("Policy profiles are unresolved");
  const root = join(dataDir(), "fleet");
  return createHash("sha256").update(JSON.stringify([
    profiles, ...["plans.json", "afc.config.json", "paused-projects.json"].map(name => bytes(join(root, name))),
  ])).digest("hex");
}

export function capturePolicyDigest(): string | null { try { return policyDigest(); } catch { return null; } }

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validatePolicySnapshot(raw: unknown, digest: string, now = Date.now()): PolicyRead {
  const result = PolicySnapshot.safeParse(raw);
  if (!result.success) return { state: "invalid", reason: "Policy snapshot schema is invalid" };
  const snapshot = result.data;
  if (snapshot.policyDigest !== digest) return { state: "invalid", reason: "Policy revision changed; awaiting recomputation" };
  if (Date.parse(snapshot.pools.generatedAt) > now + 30_000) return { state: "invalid", reason: "Policy snapshot is from the future" };
  return { state: "ok", snapshot: freeze(snapshot) };
}

export function readPersistedPolicy(now = Date.now()): PolicyRead {
  try {
    const path = policySnapshotPath();
    if (!existsSync(path)) return { state: "absent", reason: "Policy snapshot is not available" };
    return validatePolicySnapshot(JSON.parse(readFileSync(path, "utf8")), policyDigest(), now);
  } catch { return { state: "invalid", reason: "Policy snapshot or inputs are unreadable" }; }
}

/** Injectable channel keeps the scheduler independent of Fleet collectors and filesystem exports. */
export interface PolicyChannel { read(now: number): PolicyRead }
let channel: PolicyChannel | null = null;
export function injectPolicyChannel(next: PolicyChannel): () => void {
  channel = next;
  return () => { if (channel === next) channel = null; };
}
export const hasPolicyChannel = () => channel !== null;
export function readPolicy(now = Date.now()): PolicyRead { return channel ? channel.read(now) : readPersistedPolicy(now); }

export function createPolicyChannel() {
  let current: Readonly<Snapshot> | null = null;
  let disposed = false;
  return {
    read(now: number): PolicyRead {
      if (disposed) return { state: "absent", reason: "Fleet policy service is disposed" };
      if (!current) return readPersistedPolicy(now);
      try { return validatePolicySnapshot(current, policyDigest(), now); }
      catch { return { state: "invalid", reason: "Policy inputs are unreadable" }; }
    },
    accept(snapshot: Readonly<Snapshot>): void {
      if (disposed) return;
      if (current && (snapshot.revision <= current.revision || Date.parse(snapshot.pools.generatedAt) < Date.parse(current.pools.generatedAt))) throw new Error("Policy revision regressed");
      current = freeze(structuredClone(snapshot));
    },
    dispose(): void { disposed = true; current = null; },
  };
}

let onPublished: ((snapshot: Readonly<Snapshot>) => void) | null = null;
export function onPolicyPublished(callback: (snapshot: Readonly<Snapshot>) => void): () => void {
  onPublished = callback;
  return () => { if (onPublished === callback) onPublished = null; };
}

/** Short synchronous commit serialized with dispatch admission. Async collection stays outside the lock. */
export function publishPolicySnapshot(input: Omit<Snapshot, "schema" | "revision">, capturedDigest: string): Readonly<Snapshot> {
  return withConfigLock(() => {
    if (policyDigest() !== capturedDigest || input.policyDigest !== capturedDigest) throw new Error("Policy inputs changed while collecting");
    const path = policySnapshotPath();
    const previous = existsSync(path) ? PolicySnapshot.parse(JSON.parse(readFileSync(path, "utf8"))) : null;
    if (previous && Date.parse(input.pools.generatedAt) < Date.parse(previous.pools.generatedAt)) throw new Error("Policy timestamp regressed");
    const result = validatePolicySnapshot({ ...input, schema: "paseo-policy/v1", revision: (previous?.revision ?? 0) + 1 }, capturedDigest, Date.parse(input.pools.generatedAt));
    if (result.state !== "ok") throw new Error(result.reason);
    mkdirSync(join(dataDir(), "fleet"), { recursive: true });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(result.snapshot), { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
    onPublished?.(result.snapshot);
    return result.snapshot;
  });
}
