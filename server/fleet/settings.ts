/// <reference types="node" />
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IN_USE_MARKERS, resolveSwitches } from "./adapters/config";
import { OPTIONAL_ADAPTERS } from "../../shared/fleet/quota-adapters";
import { afcPluginDir } from "./paths";
import { afcSettingsSchema, plansSchema, type SettingsFile, type SettingsSnapshot } from "../../shared/fleet/settings";
import { languageOverride, resolveLanguage, setLanguage } from "../../shared/fleet/i18n";
import { STATE_DIR } from "./util";
import { cycleKey } from "../../shared/fleet/quota-cycle";

const names = { plans: "plans.json", config: "afc.config.json" } as const;
/** Startup only: exclusive creation never replaces an existing configuration, even if malformed. */
export function initializeSettings(dir = STATE_DIR, examplesDir?: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [file, example] of [[names.plans, "plans.example.json"], [names.config, "afc.config.example.json"]] as const) {
    const target = join(dir, file);
    if (existsSync(target)) continue;
    if (file === names.plans) {
      try { writeFileSync(target, JSON.stringify({ schemaVersion: 2, plans: [], dispatchPriority: null }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      continue;
    }
    const plugin = examplesDir ? null : afcPluginDir();
    const source = examplesDir ?? (plugin ? join(plugin, "examples") : null);
    if (!source) throw new Error("Plugin installation directory is unavailable for first-run configuration");
    let bytes = readFileSync(join(source, example), "utf8");
    const document = JSON.parse(bytes);
    if (file === names.config) {
      // Preserve pre-switch installations: unset switches still follow their in-use markers.
      for (const adapter of OPTIONAL_ADAPTERS) {
        if (IN_USE_MARKERS[adapter].some(marker => existsSync(join(dir, marker)))) delete document.adapters?.[adapter];
      }
      bytes = JSON.stringify(document, null, 2) + "\n";
    }
    try { writeFileSync(target, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
function revision(bytes: string): string { return createHash("sha256").update(bytes).digest("hex"); }
async function readDocument(file: SettingsFile, dir: string): Promise<{ document: Record<string, unknown>; revision: string }> {
  const bytes = await readFile(join(dir, names[file]), "utf8");
  const document = JSON.parse(bytes);
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Configuration must be an object");
  return { document, revision: revision(bytes) };
}
export async function readSettings(file: SettingsFile, dir = STATE_DIR): Promise<SettingsSnapshot> {
  const snapshot = await readDocument(file, dir);
  const config = file === "config" ? snapshot.document : (await readDocument("config", dir)).document;
  const inUse = await Promise.all(OPTIONAL_ADAPTERS.map(async adapter => {
    const present = await Promise.all(IN_USE_MARKERS[adapter].map(marker => access(join(dir, marker)).then(() => true, () => false)));
    return present.some(Boolean);
  }));
  const effectiveAdapters = resolveSwitches(config, adapter => inUse[OPTIONAL_ADAPTERS.indexOf(adapter)]);
  return { ...snapshot, effectiveAdapters, language: languageOverride(process.env) ?? resolveLanguage(config.language) };
}
const writes = new Map<string, Promise<unknown>>();
/** Serialize optimistic writes per file; the document and its revision always come from the same read. */
export async function writeSettings(input: { file: SettingsFile; revision: string; document: Record<string, unknown> }, dir = STATE_DIR) {
  const path = join(dir, names[input.file]);
  const pending = (writes.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const current = await readSettings(input.file, dir);
    if (current.revision !== input.revision) return { status: "conflict" as const, snapshot: current };
    const parsed = (input.file === "plans" ? plansSchema : afcSettingsSchema).parse(input.document);
    if (input.file === "plans") {
      const plans = plansSchema.parse(parsed).plans;
      const previous = Array.isArray(current.document.plans) ? current.document.plans as Record<string, unknown>[] : [];
      for (const plan of plans) {
        const prior = previous.find(row => row.id === plan.id);
        if (plan.quotaCycle && plan.manualOverride && JSON.stringify(prior?.manualOverride) !== JSON.stringify(plan.manualOverride)) plan.manualOverride.cycleKey = cycleKey(plan.quotaCycle);
      }
      parsed.plans = plans;
    }
    const bytes = JSON.stringify(parsed, null, 2) + "\n";
    const temp = `${path}.${randomUUID()}.tmp`;
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      // Detect external edits that occurred while preparing the replacement.
      const latest = await readSettings(input.file, dir);
      if (latest.revision !== input.revision) return { status: "conflict" as const, snapshot: latest };
      await rename(temp, path);
    } finally { await rm(temp, { force: true }); }
    const snapshot = await readSettings(input.file, dir);
    if (input.file === "config") setLanguage(snapshot.language);
    return { status: "saved" as const, snapshot };
  });
  writes.set(path, pending);
  try { return await pending; } finally { if (writes.get(path) === pending) writes.delete(path); }
}
