// Reading and writing contract files.
// Read states: absent (no file: the other plugin is not installed), invalid (bad JSON or schema;
// callers treat it like absent), stale (older than ttlSeconds * 3), fresh.
// Writes go to a temporary file in the same directory and are renamed into place, so readers
// never see a half-written file.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { z } from "zod";
import { CONTRACT_SCHEMA, CONTRACT_VERSION, EXPORTS, type Envelope, type ExportKind, type ExportPayload } from "../../shared/contract/schema";
import { exportPath, type Env } from "./paths";

/** A file older than its TTL times this factor is stale. */
export const STALE_FACTOR = 3;

export type ReadResult<T> =
  | { state: "absent" }
  | { state: "invalid"; reason: string }
  | { state: "stale"; value: T; ageSeconds: number }
  | { state: "fresh"; value: T; ageSeconds: number };

export type Freshness = "fresh" | "stale";

export interface ReadOptions {
  now?: Date;
  /** Called for invalid files. Wrap with `onceLogger` to log each problem only once. */
  onInvalid?: (file: string, reason: string) => void;
}

/** Age in seconds of an envelope at `now`. A timestamp in the future counts as age 0. */
export function envelopeAgeSeconds(envelope: Pick<Envelope, "generatedAt">, now: Date): number {
  const age = (now.getTime() - Date.parse(envelope.generatedAt)) / 1000;
  return Math.max(0, age);
}

export function classifyFreshness(envelope: Pick<Envelope, "generatedAt" | "ttlSeconds">, now: Date): Freshness {
  return envelopeAgeSeconds(envelope, now) > envelope.ttlSeconds * STALE_FACTOR ? "stale" : "fresh";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Parse already-loaded text against a payload schema and classify it. Pure apart from `now`. */
export function parseContract<S extends z.ZodType<Envelope>>(
  text: string,
  schema: S,
  now: Date = new Date(),
): ReadResult<z.infer<S>> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { state: "invalid", reason: `bad JSON: ${errorMessage(error)}` };
  }
  const declared = typeof json === "object" && json !== null ? (json as { schema?: unknown }).schema : undefined;
  if (declared !== CONTRACT_SCHEMA) {
    return { state: "invalid", reason: `schema is ${JSON.stringify(declared)}, expected ${CONTRACT_SCHEMA}` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { state: "invalid", reason: describeIssues(parsed.error) };
  const value = parsed.data as z.infer<S>;
  const ageSeconds = envelopeAgeSeconds(value, now);
  return { state: classifyFreshness(value, now), value, ageSeconds };
}

/** Read one contract file from an explicit path. Never throws for missing or malformed files. */
export async function readContractFile<S extends z.ZodType<Envelope>>(
  file: string,
  schema: S,
  options: ReadOptions = {},
): Promise<ReadResult<z.infer<S>>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "absent" };
    const result = { state: "invalid", reason: `unreadable: ${errorMessage(error)}` } as const;
    options.onInvalid?.(file, result.reason);
    return result;
  }
  const result = parseContract(text, schema, options.now);
  if (result.state === "invalid") options.onInvalid?.(file, result.reason);
  return result;
}

/** Read an export by kind from its producer's exports directory. */
export async function readExport<K extends ExportKind>(
  kind: K,
  options: ReadOptions & { env?: Env; home?: string } = {},
): Promise<ReadResult<ExportPayload<K>>> {
  const file = exportPath(kind, options.env, options.home);
  return readContractFile(file, EXPORTS[kind].schema, options) as Promise<ReadResult<ExportPayload<K>>>;
}

/**
 * Validate and atomically write a contract file: write a sibling temp file, then rename it.
 * Throws if the value does not match the schema; nothing is written in that case.
 */
export async function writeContractFile<S extends z.ZodType<Envelope>>(
  file: string,
  schema: S,
  value: z.input<S>,
): Promise<z.infer<S>> {
  const checked = schema.parse(value);
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(checked, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return checked;
}

/** Write an export by kind into this plugin's exports directory. */
export async function writeExport<K extends ExportKind>(
  kind: K,
  value: ExportPayload<K>,
  options: { env?: Env; home?: string } = {},
): Promise<ExportPayload<K>> {
  const file = exportPath(kind, options.env, options.home);
  const schema = EXPORTS[kind].schema as unknown as z.ZodType<ExportPayload<K>>;
  return writeContractFile(file, schema, value);
}

/** Build the envelope fields for an export, using its default TTL. */
export function envelopeFor(kind: ExportKind, producerVersion: string, now: Date = new Date()): Envelope {
  const spec = EXPORTS[kind];
  return {
    schema: CONTRACT_SCHEMA,
    contractVersion: CONTRACT_VERSION,
    producer: spec.producer,
    producerVersion,
    generatedAt: now.toISOString(),
    ttlSeconds: spec.ttlSeconds,
  };
}

/** Wrap a logger so each (file, reason) pair is reported once per process. */
export function onceLogger(log: (message: string) => void): (file: string, reason: string) => void {
  const seen = new Set<string>();
  return (file, reason) => {
    const key = `${file}\n${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    log(`fleet-quota: ignoring invalid ${file}: ${reason}`);
  };
}
