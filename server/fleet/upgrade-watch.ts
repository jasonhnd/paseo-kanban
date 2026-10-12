/// <reference types="node" />
// About 3 minutes after the plugin loads, and then every hour: if the daemon
// version changed, run `npm run compat` in the three plugin directories.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { parseDaemonVersion } from "./daemon-log";
import {
  COMPAT_STATE_PATH,
  type CompatState,
  defaultPlugins,
  normalizeListed,
  normalizeState,
  parseVersion,
  runUpgradeCheck,
} from "./upgrade-check";
import { t } from "../../shared/fleet/i18n";
import { findCommand } from "./commands";
import { BIN, PASEO_DIR, readJson, writeJson, sendToAgent } from "./util";

export const COMPAT_FIRST_DELAY_MS = 3 * 60_000;
export const COMPAT_INTERVAL_MS = 60 * 60_000;
export const COMPAT_TIMEOUT_MS = 10 * 60_000;

function npmBin(): string | null {
  const sibling = join(dirname(process.execPath), "npm");
  return existsSync(sibling) ? sibling : findCommand("npm");
}

function runNpmCompat(dir: string): Promise<{ ok: boolean; timedOut: boolean; output: string }> {
  const npm = npmBin();
  if (!npm) return Promise.resolve({ ok: false, timedOut: false, output: t("upgrade.watch.noNpm") });
  const env = {
    ...process.env,
    PATH: [dirname(npm), process.env.PATH ?? ""].filter(Boolean).join(delimiter),
  };
  return new Promise((resolve) => {
    execFile(npm, ["run", "compat", "--silent"], { cwd: dir, env, timeout: COMPAT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout ?? ""}\n${stderr ?? ""}`;
      if (!err) {
        resolve({ ok: true, timedOut: false, output });
        return;
      }
      const failed = err as NodeJS.ErrnoException & { killed?: boolean };
      const timedOut = Boolean(failed.killed) || failed.code === "ETIMEDOUT";
      resolve({ ok: false, timedOut, output: output || String(err.message) });
    });
  });
}

async function currentVersion(): Promise<string | null> {
  const fromCli = await new Promise<string>((resolve) => {
    execFile(BIN.paseo, ["--version"], { timeout: 15_000 }, (err, stdout) => {
      resolve(err ? "" : String(stdout ?? ""));
    });
  });
  const parsed = parseVersion(fromCli);
  if (parsed) return parsed;
  const text = await readFile(join(PASEO_DIR, "daemon.log"), "utf8").catch(() => "");
  return parseDaemonVersion(text);
}

async function listAgents() {
  const stdout = await new Promise<string>((resolve) => {
    execFile(BIN.paseo, ["ls", "-g", "--json"], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
      resolve(err ? "" : String(out ?? ""));
    });
  });
  if (!stdout.trim()) return [];
  try {
    return normalizeListed(JSON.parse(stdout));
  } catch {
    return [];
  }
}

let running = false;

/** Start a check unless one is already running. `force` runs the three scripts even when the version is unchanged. */
export function beginCompatCheck(opts: { force: boolean }): { started: boolean; message: string } {
  if (running) return { started: false, message: t("upgrade.watch.running") };
  running = true;
  void runUpgradeCheck(
    {
      readState: async () => normalizeState(await readJson<unknown>(COMPAT_STATE_PATH, null)),
      writeState: async (state: CompatState) => {
        await writeJson(COMPAT_STATE_PATH, state);
      },
      currentVersion,
      plugins: defaultPlugins(),
      hasCompatScript: async (dir: string) => {
        const pkg = await readJson<{ scripts?: { compat?: unknown } }>(join(dir, "package.json"), {});
        return typeof pkg.scripts?.compat === "string" && pkg.scripts.compat.length > 0;
      },
      runCompat: runNpmCompat,
      listAgents,
      send: sendToAgent,
      now: () => new Date().toISOString(),
    },
    opts,
  )
    .then((outcome) => {
      console.log(`[afc] compat watch: ${outcome.reason} version=${outcome.state?.version ?? "?"}`);
    })
    .catch((e) => {
      console.error("[afc] compat watch:", String(e).slice(0, 300));
    })
    .finally(() => {
      running = false;
    });
  return {
    started: true,
    message: opts.force ? t("upgrade.watch.startedForce") : t("upgrade.watch.startedQuiet"),
  };
}

/** First pass about 3 minutes after load, then once an hour. */
export function startCompatWatch(): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    beginCompatCheck({ force: false });
    interval = setInterval(() => {
      beginCompatCheck({ force: false });
    }, COMPAT_INTERVAL_MS);
  }, COMPAT_FIRST_DELAY_MS);
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
