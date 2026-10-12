/// <reference types="node" />
// One durable schedule for AFC quota readers; neither RPC access nor publication slides it.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { QUOTA_SAMPLE_MS } from "./quota-timing";
import { STATE_DIR, writeJson } from "./util";

export const QUOTA_SAMPLING_FILE = join(STATE_DIR, "quota-sampling.json");
export interface QuotaSample<T> {
  value: T | null;
  /** AFC invocation time, not a provider-source timestamp. */
  attemptedAt: string | null;
  /** Invocation time of the stored value, including failed reader results. */
  collectedAt: string | null;
  error: string | null;
}
interface Entry extends QuotaSample<unknown> { slot: number; claim: string }
interface Schedule { version: 1; anchor: number; sources: Record<string, Entry> }
const inflight = new Map<string, Promise<QuotaSample<unknown>>>();

async function readSchedule(path: string): Promise<Schedule | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const file = JSON.parse(text) as Schedule;
  if (file?.version !== 1 || !Number.isFinite(file.anchor) || !file.sources || typeof file.sources !== "object" || Array.isArray(file.sources)) throw new Error("Invalid quota sampling schedule; sampling refused");
  for (const entry of Object.values(file.sources)) {
    if (!entry || !Number.isInteger(entry.slot) || entry.slot < 0 || typeof entry.claim !== "string"
      || !(entry.attemptedAt === null || typeof entry.attemptedAt === "string" && Number.isFinite(Date.parse(entry.attemptedAt)))
      || !(entry.collectedAt === null || typeof entry.collectedAt === "string" && Number.isFinite(Date.parse(entry.collectedAt)))
      || !(entry.error === null || typeof entry.error === "string")) throw new Error("Invalid quota sampling entry; sampling refused");
  }
  return file;
}

/** Short same-host file mutex. An abandoned lock fails closed; it is never stolen on a timeout. */
async function locked<T>(path: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { lock = await open(lockPath, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  if (!lock) throw new Error("Quota sampling lock is busy or abandoned; sampling refused");
  try {
    await lock.writeFile(`${process.pid}\n`);
    return await work();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export interface SamplingOptions<T> {
  now?: number;
  statePath?: string;
  /** Reader failures returned as data also consume the slot and remain visible. */
  errorOf?: (value: T) => string | null;
}

export function sampleQuota<T>(source: string, read: () => Promise<T>, options: SamplingOptions<T> = {}): Promise<QuotaSample<T>> {
  if (!/^[a-z][a-z0-9-]*$/.test(source)) return Promise.reject(new Error("Invalid quota sampling source"));
  const path = options.statePath ?? QUOTA_SAMPLING_FILE;
  const key = `${path}:${source}`;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<QuotaSample<T>>;
  const task = sample(source, read, path, options);
  inflight.set(key, task);
  void task.then(() => inflight.delete(key), () => inflight.delete(key));
  return task;
}

async function sample<T>(source: string, read: () => Promise<T>, path: string, options: SamplingOptions<T>): Promise<QuotaSample<T>> {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new Error("Invalid quota sampling clock");
  const reservation = await locked(path, async () => {
    const file: Schedule = await readSchedule(path) ?? { version: 1, anchor: now, sources: {} };
    const previous = file.sources[source];
    // A clock rollback cannot open another slot or move the anchor.
    const slot = Math.max(0, Math.floor((now - file.anchor) / QUOTA_SAMPLE_MS));
    if (previous && slot <= previous.slot) return { entry: previous, claimed: false };
    const entry: Entry = { value: previous?.value ?? null, collectedAt: previous?.collectedAt ?? null,
      attemptedAt: new Date(now).toISOString(), error: "Quota sample pending or interrupted", slot, claim: randomUUID() };
    file.sources[source] = entry;
    await writeJson(path, file);
    return { entry, claimed: true };
  });
  if (!reservation.claimed) return reservation.entry as QuotaSample<T>;
  const result: Entry = { ...reservation.entry };
  try {
    result.value = await read();
    result.collectedAt = result.attemptedAt;
    result.error = options.errorOf?.(result.value as T) ?? null;
  } catch (error) {
    result.error = String(error).slice(0, 300);
    // The retained value keeps its old collectedAt, even when publication continues.
  }
  await locked(path, async () => {
    const file = await readSchedule(path);
    // A very late result cannot overwrite a newer slot.
    if (file?.sources[source]?.claim === result.claim) {
      file.sources[source] = result;
      await writeJson(path, file);
    }
  });
  return result as QuotaSample<T>;
}
