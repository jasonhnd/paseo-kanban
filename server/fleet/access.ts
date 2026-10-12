/// <reference types="node" />
// Every 30 minutes, run the official status command for each service in access-map.json.
// `claude mcp list` is the exception: 120s timeout, every 6 hours, and when the page asks to recheck.
// That slow command does not hold the rest of the page. The cache keeps login, connector name,
// and whether the Slack plugin is running. Tokens and auth URLs are never written.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { accessProfiles, type AccessView, buildAccessView, parseAccessMap, type MapService } from "../../shared/fleet/access";
import { commandAllowed, isCursorStatus, isSlowStatusCommand, type LiveCheck, parseStatusOutput, STATUS_COMMANDS, type StatusCommand, type StatusOutcome } from "../../shared/fleet/access-parse";
import { cursorAccessPatch } from "../../shared/fleet/cursor-login";
import { t } from "../../shared/fleet/i18n";
import { CURSOR_API, poolNames } from "../../shared/fleet/quota-adapters";
import { adapterOn } from "./adapters/config";
import { readPoolCatalog } from "./adapters/plans";
import { checkCursorLogin, readCursorLoginView } from "./cursor-login";
import { nvmBinDirs } from "./node-paths";
import { BIN, CONFIG, HOME, readJson, STATE_DIR, writeJson } from "./util";

export const ACCESS_MAP_PATH = join(STATE_DIR, "access-map.json");
export const ACCESS_STATUS_PATH = join(STATE_DIR, "access-status.json");
export const ACCESS_INTERVAL_MS = 30 * 60 * 1000;
export const ACCESS_SLOW_INTERVAL_MS = 6 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20_000;
const SLOW_TIMEOUT_MS = 120_000;
const START_DELAY_MS = 8_000;

interface StatusCache {
  checkedAt: string;
  slowCheckedAt: string;
  services: Record<string, LiveCheck>;
}

let fastBusy = false;
let slowBusy = false;
let fastInflight: Promise<void> | null = null;
let slowInflight: Promise<void> | null = null;
let writeChain: Promise<void> = Promise.resolve();

function emptyCache(): StatusCache {
  return { checkedAt: "", slowCheckedAt: "", services: {} };
}

async function readCache(): Promise<StatusCache> {
  const cache = await readJson<Partial<StatusCache>>(ACCESS_STATUS_PATH, emptyCache());
  return {
    checkedAt: typeof cache.checkedAt === "string" ? cache.checkedAt : "",
    slowCheckedAt: typeof cache.slowCheckedAt === "string" ? cache.slowCheckedAt : "",
    services: cache.services && typeof cache.services === "object" ? cache.services : {},
  };
}

function updateCache(mutate: (cache: StatusCache) => void): Promise<void> {
  const run = writeChain.then(async () => {
    const cache = await readCache();
    mutate(cache);
    await writeJson(ACCESS_STATUS_PATH, cache);
  });
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

async function statusEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(token|secret|password|authorization|api[-_]?key|bearer)/i.test(key)) continue;
    env[key] = value;
  }
  const nodeBins = await nvmBinDirs();
  env.PATH = [...nodeBins, join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", env.PATH ?? ""].join(":");
  return env;
}

function runStatus(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<StatusOutcome> {
  return new Promise((resolve) => {
    const MAX_CAPTURE = 256 * 1024;
    // nvm ships an older `paseo` that has no `plugin` subcommand. The allowlist still says `paseo`.
    const executable = bin === "paseo" ? BIN.paseo : bin;
    const child = spawn(executable, args, { env: bin === "neonctl" ? { ...env, CI: "1" } : env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (row: StatusOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(row);
    };
    const watch = () => {
      if (`${stdout}\n${stderr}`.includes("Awaiting authentication")) {
        child.kill("SIGKILL");
        done({ ok: false, stdout: "", stderr: "", timedOut: false, missing: false, abortedLogin: true });
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, stdout: "", stderr: "", timedOut: true, missing: false, abortedLogin: false });
    }, timeoutMs);
    child.stdout?.on("data", (buf: Buffer) => {
      if (settled || stdout.length >= MAX_CAPTURE) return;
      stdout = (stdout + String(buf)).slice(0, MAX_CAPTURE);
      watch();
    });
    child.stderr?.on("data", (buf: Buffer) => {
      if (settled || stderr.length >= MAX_CAPTURE) return;
      stderr = (stderr + String(buf)).slice(0, MAX_CAPTURE);
      watch();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      done({ ok: false, stdout: "", stderr: "", timedOut: false, missing: err.code === "ENOENT", abortedLogin: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      done({ ok: code === 0, stdout, stderr, timedOut: false, missing: false, abortedLogin: false });
    });
  });
}

function listed(service: MapService, spec: StatusCommand | null, commandId: string): boolean {
  const allowed = STATUS_COMMANDS[commandId];
  if (!spec || service.blocked || !allowed || !commandAllowed(spec.bin, spec.args)) return false;
  return allowed.bin === spec.bin && allowed.args.join("\0") === spec.args.join("\0");
}

async function runOne(id: string, spec: StatusCommand, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<LiveCheck> {
  try {
    return parseStatusOutput(id, await runStatus(spec.bin, spec.args, env, timeoutMs), spec.pluginId);
  } catch {
    return { state: "unknown", account: null, scopeCount: null, detail: t("access.detail.commandFailed") };
  }
}

async function runFast(): Promise<void> {
  const map = parseAccessMap(await readJson<unknown>(ACCESS_MAP_PATH, { services: [] }));
  const env = await statusEnv();
  const services: Record<string, LiveCheck> = {};
  await Promise.all(map.map(async (service) => {
    // The Cursor CLI status belongs to the Cursor login watch (cursor-api adapter), never to this pass.
    if (isCursorStatus(service.check)) return;
    const spec = service.check;
    if (spec && !isSlowStatusCommand(spec.bin, spec.args) && listed(service, spec, service.id)) {
      services[service.id] = await runOne(service.id, spec, env, COMMAND_TIMEOUT_MS);
    }
    if (service.also && listed(service, service.also, `${service.id}-plugin`)) {
      services[`${service.id}-plugin`] = await runOne(`${service.id}-plugin`, service.also, env, COMMAND_TIMEOUT_MS);
    }
  }));
  await updateCache((cache) => {
    cache.checkedAt = new Date().toISOString();
    const keepSlow = new Set(map.filter((service) => service.check && isSlowStatusCommand(service.check.bin, service.check.args)).map((service) => service.id));
    for (const id of Object.keys(cache.services)) {
      if (keepSlow.has(id) || id.endsWith("-plugin")) continue;
      if (!services[id]) delete cache.services[id];
    }
    Object.assign(cache.services, services);
  });
}

async function runSlow(): Promise<void> {
  const map = parseAccessMap(await readJson<unknown>(ACCESS_MAP_PATH, { services: [] }));
  const targets = map.filter((service) => service.check && isSlowStatusCommand(service.check.bin, service.check.args) && listed(service, service.check, service.id));
  const spec = targets[0]?.check;
  if (!spec) {
    await updateCache((cache) => {
      cache.slowCheckedAt = new Date().toISOString();
    });
    return;
  }
  const env = await statusEnv();
  const outcome = await runStatus(spec.bin, spec.args, env, SLOW_TIMEOUT_MS);
  await updateCache((cache) => {
    cache.slowCheckedAt = new Date().toISOString();
    for (const service of targets) {
      if (!service.check || service.check.bin !== spec.bin || service.check.args.join("\0") !== spec.args.join("\0")) continue;
      cache.services[service.id] = parseStatusOutput(service.id, outcome);
    }
  });
}

function ensureFast(): Promise<void> {
  if (!fastInflight) {
    fastBusy = true;
    fastInflight = Promise.all([runFast(), checkCursorLogin()])
      .then(() => undefined)
      .catch((error) => {
        console.error("[afc] access:", String(error).slice(0, 160));
      })
      .finally(() => {
        fastInflight = null;
        fastBusy = false;
      });
  }
  return fastInflight;
}

function ensureSlow(): Promise<void> {
  if (!slowInflight) {
    slowBusy = true;
    slowInflight = runSlow()
      .catch((error) => {
        console.error("[afc] access mcp:", String(error).slice(0, 160));
      })
      .finally(() => {
        slowInflight = null;
        slowBusy = false;
      });
  }
  return slowInflight;
}

async function needsFast(): Promise<boolean> {
  const cache = await readCache();
  const at = Date.parse(cache.checkedAt);
  if (Number.isNaN(at) || Date.now() - at >= ACCESS_INTERVAL_MS) return true;
  const map = parseAccessMap(await readJson<unknown>(ACCESS_MAP_PATH, { services: [] }));
  return map.some((service) => {
    if (isCursorStatus(service.check) || service.blocked || !service.check) return false;
    if (isSlowStatusCommand(service.check.bin, service.check.args)) {
      return Boolean(service.also) && !cache.services[`${service.id}-plugin`];
    }
    return !cache.services[service.id];
  });
}

async function slowIsStale(): Promise<boolean> {
  const cache = await readCache();
  const at = Date.parse(cache.slowCheckedAt);
  return Number.isNaN(at) || Date.now() - at >= ACCESS_SLOW_INTERVAL_MS;
}

/** `now` reruns every status command, including the slow MCP list, and resolves when the fast ones finish. */
export function refreshAccess(mode: "boot" | "interval" | "now" = "boot"): Promise<void> {
  const fast = (async () => {
    if (mode === "boot") {
      if (await needsFast()) await ensureFast();
      return;
    }
    await ensureFast();
  })();
  if (mode === "now") ensureSlow();
  else void slowIsStale().then((stale) => { if (stale) ensureSlow(); });
  return fast;
}

export async function readAccessView(): Promise<AccessView> {
  const [mapRaw, configRaw, cache] = await Promise.all([
    readJson<unknown>(ACCESS_MAP_PATH, null),
    readJson<unknown>(CONFIG, {}),
    readCache(),
  ]);
  const warning = mapRaw ? null : t("access.warning.noMap");
  const services = parseAccessMap(mapRaw ?? { services: [] });
  const checkedAt = cache.checkedAt || null;
  const labels = poolNames(await readPoolCatalog(), "label");
  const view = buildAccessView(services, accessProfiles(configRaw), cache.services ?? {}, checkedAt, fastBusy || slowBusy, warning, labels);
  // The Cursor row shows the login watch's state, only while the cursor-api adapter runs that watch.
  const cursor = adapterOn(CURSOR_API) ? await readCursorLoginView().catch(() => null) : null;
  if (!cursor) return view;
  const cursorRows = new Set(services.filter((service) => isCursorStatus(service.check)).map((service) => service.id));
  return {
    ...view,
    services: view.services.map((row) => {
      if (!cursorRows.has(row.id)) return row;
      const patch = cursorAccessPatch(cursor.state, row.account, row.accountLive);
      return { ...row, state: patch.state, stateLabel: patch.stateLabel, detail: patch.detail, account: patch.account, accountLive: patch.accountLive };
    }),
  };
}

export function startAccessCheck(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    void refreshAccess("boot");
    timer = setInterval(() => {
      void refreshAccess("interval");
    }, ACCESS_INTERVAL_MS);
  }, START_DELAY_MS);
  return () => {
    clearTimeout(first);
    if (timer) clearInterval(timer);
  };
}
