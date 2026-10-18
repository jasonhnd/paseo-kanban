/// <reference types="node" />
// The install directory name changes on every plugin update. Agents keep using this
// data-directory bin; startup rewrites it so the launcher runs the current install.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../shared/i18n";
import { dataDir, kanbanCliPath, pluginRoot, requestedDataDir } from "./paths";

const BIN_DIR = "bin";
const LAUNCHER_NAME = "paseo-kanban";
const BRIDGE_NAME = "memory_bridge.py";
const ERROR_NAME = "stable-bin-error";
const DIR_MODE = 0o700;
const LAUNCHER_MODE = 0o755;
const BRIDGE_MODE = 0o755;
const ERROR_MODE = 0o600;

export interface StableBinRefresh {
  ok: boolean;
  error?: string;
  launcher: string;
  bridge: string;
}

export interface StableBinFinding {
  id: "stable-bin";
  severity: "yellow";
  check: "board";
  project: null;
  card: null;
  taskId: null;
  object: string;
  symptom: string;
  evidence: string;
  suggestion: string;
}

function logStableBin(message: string): void {
  console.error(message);
}

/** Quote one shell word, including embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function launcherScript(installRoot: string): string {
  return `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(kanbanCliPath(installRoot))} "$@"\n`;
}

// The bridge file name is unique under integrations. The directory name stays out of this
// module so command bundles, which inline it, do not republish that name.
function bridgeSource(installRoot: string): string {
  let names: string[] = [];
  try { names = readdirSync(join(installRoot, "integrations")); } catch { names = []; }
  const found: string[] = [];
  for (const name of names) {
    const candidate = join(installRoot, "integrations", name, BRIDGE_NAME);
    try {
      if (lstatSync(candidate).isFile()) found.push(candidate);
    } catch { /* not this directory */ }
  }
  if (found.length !== 1) throw new Error("current install has no memory bridge");
  return found[0]!;
}

/** The board command agents should run. String only: no filesystem read, so create hooks can call it. */
export function stableLauncherPath(): string {
  return join(requestedDataDir(), BIN_DIR, LAUNCHER_NAME);
}

function stableBridgePath(root = requestedDataDir()): string {
  return join(root, BIN_DIR, BRIDGE_NAME);
}

function placeFile(dest: string, bytes: Buffer, mode: number, compare: boolean): void {
  if (compare) {
    try {
      if (readFileSync(dest).equals(bytes)) {
        if ((lstatSync(dest).mode & 0o777) !== mode) chmodSync(dest, mode);
        return;
      }
    } catch {
      // Missing or unreadable: replace below.
    }
  }
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, bytes, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created, or the rename already moved it */ }
    throw err;
  }
}

function clearError(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
    if (code !== "ENOENT") throw err;
  }
}

/**
 * Rewrite the stable bin from `installRoot`. A failure is logged and recorded for doctor.
 * The test-data guard still throws before any write. Other failures return `{ ok: false }`.
 */
export function refreshStableBin(installRoot = pluginRoot(), log: (message: string) => void = logStableBin): StableBinRefresh {
  const root = dataDir();
  const bin = join(root, BIN_DIR);
  const launcher = join(bin, LAUNCHER_NAME);
  const bridge = join(bin, BRIDGE_NAME);
  const errorPath = join(root, ERROR_NAME);
  try {
    const script = Buffer.from(launcherScript(installRoot), "utf8");
    const bridgeBytes = readFileSync(bridgeSource(installRoot));
    mkdirSync(root, { recursive: true, mode: DIR_MODE });
    chmodSync(root, DIR_MODE);
    mkdirSync(bin, { recursive: true, mode: DIR_MODE });
    chmodSync(bin, DIR_MODE);
    placeFile(launcher, script, LAUNCHER_MODE, false);
    placeFile(bridge, bridgeBytes, BRIDGE_MODE, true);
    clearError(errorPath);
    return { ok: true, launcher, bridge };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { log(`[paseo-kanban] stable bin: ${message}`); } catch { /* a broken logger must not hide the failure */ }
    try {
      mkdirSync(root, { recursive: true, mode: DIR_MODE });
      placeFile(errorPath, Buffer.from(`${message}\n`, "utf8"), ERROR_MODE, false);
    } catch (writeErr) {
      const extra = writeErr instanceof Error ? writeErr.message : String(writeErr);
      try { log(`[paseo-kanban] stable bin: could not record the refresh error: ${extra}`); } catch { /* ignore */ }
    }
    return { ok: false, error: message, launcher, bridge };
  }
}

/** Yellow when the stable bin is missing, stale, or the last refresh failed. Null when it matches. */
export function stableBinFinding(installRoot = pluginRoot()): StableBinFinding | null {
  const root = dataDir();
  const bin = join(root, BIN_DIR);
  const launcher = join(bin, LAUNCHER_NAME);
  const bridge = stableBridgePath(root);
  const problems: string[] = [];
  const errorPath = join(root, ERROR_NAME);
  if (existsSync(errorPath)) {
    let text = "";
    try { text = readFileSync(errorPath, "utf8").trim().slice(0, 500); } catch (err) {
      text = err instanceof Error ? err.message : String(err);
    }
    problems.push(text || "refresh failed");
  }
  const quotedTarget = shellQuote(kanbanCliPath(installRoot));
  let launcherText = "";
  try { launcherText = readFileSync(launcher, "utf8"); } catch { problems.push("launcher missing"); }
  if (launcherText && !launcherText.includes(quotedTarget)) problems.push("launcher does not name the current install");
  if (launcherText) {
    try {
      if ((lstatSync(launcher).mode & 0o777) !== LAUNCHER_MODE) problems.push("launcher is not executable");
    } catch { problems.push("launcher missing"); }
  }
  let source: Buffer | null = null;
  try { source = readFileSync(bridgeSource(installRoot)); } catch { problems.push("current install has no memory bridge"); }
  let copy: Buffer | null = null;
  try { copy = readFileSync(bridge); } catch { problems.push("memory bridge copy missing"); }
  if (source && copy && !source.equals(copy)) problems.push("memory bridge copy differs from the current install");
  if (problems.length === 0) return null;
  return {
    id: "stable-bin",
    severity: "yellow",
    check: "board",
    project: null,
    card: null,
    taskId: null,
    object: bin,
    symptom: t("doctor.stableBin.symptom"),
    evidence: t("doctor.stableBin.evidence", { details: problems.join("; ") }),
    suggestion: t("doctor.stableBin.suggestion", { dir: bin, launcher, bridge }),
  };
}
