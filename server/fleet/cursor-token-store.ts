/// <reference types="node" />
// AFC's own Cursor tokens. The only implementation is a file the local user can read.
// Nothing in this module reads another app's tokens, and it never logs file contents.
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { t } from "../../shared/fleet/i18n";
import type { CursorTokens } from "./cursor-api";
import { cursorTokenPaths } from "./paths";

const TOKEN_PATHS = cursorTokenPaths();
/** `<data dir>/secrets/cursor-token.json` (directory 0700, file 0600). Never committed, never logged. */
export const CURSOR_TOKEN_FILE = TOKEN_PATHS.current;
/** Where older installs kept the file (`<data dir>/state/`). Still read while the new file does not exist. */
export const LEGACY_CURSOR_TOKEN_FILE = TOKEN_PATHS.legacy;

export function msgTokenUnreadable(): string {
  return t("cursor.token.unreadable");
}
export function msgTokenMode(): string {
  return t("cursor.token.mode");
}
export function msgTokenSave(): string {
  return t("cursor.token.save");
}
export function msgTokenWrite(): string {
  return t("cursor.token.write");
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export type TokenRead =
  | { ok: true; tokens: CursorTokens }
  | { ok: false; reason: "missing" | "unreadable" | "insecure" };

export interface TokenStore {
  get(): Promise<TokenRead>;
  set(tokens: CursorTokens): Promise<void>;
  delete(): Promise<void>;
}

/** True when any permission bit outside owner read/write is set. 0400 is narrower, so it is allowed. */
export function modeIsWiderThanOwnerReadWrite(mode: number): boolean {
  return (mode & 0o777 & ~FILE_MODE) !== 0;
}

export async function ensureTokenDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE);
}

/** Write the new payload to a 0600 temp file in the same directory. The destination is not touched. */
export async function stageTokenFile(file: string, body: string): Promise<string> {
  const dir = dirname(file);
  await ensureTokenDir(dir);
  const tmp = join(dir, `.cursor-token.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await open(tmp, "wx", FILE_MODE);
  try {
    await fh.writeFile(body, "utf8");
    await fh.sync();
  } catch (err) {
    // Best-effort cleanup; the original write error is what gets rethrown.
    await fh.close().catch(() => { /* already closed or broken */ });
    await unlink(tmp).catch(() => { /* temp file may already be gone */ });
    throw err;
  }
  await fh.close();
  const st = await lstat(tmp);
  if (!st.isFile() || modeIsWiderThanOwnerReadWrite(st.mode)) {
    await unlink(tmp).catch(() => { /* best-effort temp cleanup */ });
    throw new Error(msgTokenWrite());
  }
  return tmp;
}

/** Replace the destination only after the temp file is complete. Same-directory rename is atomic. */
export async function commitTokenFile(tmp: string, file: string): Promise<void> {
  await rename(tmp, file);
}

function tokenBody(tokens: CursorTokens): string {
  return JSON.stringify({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    authId: tokens.authId,
  });
}

function parseTokens(raw: string): CursorTokens | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.accessToken !== "string" || typeof row.refreshToken !== "string" || !row.accessToken || !row.refreshToken) return null;
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    authId: typeof row.authId === "string" ? row.authId : "",
  };
}

export function createFileTokenStore(file: string): TokenStore {
  return {
    async get() {
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await lstat(file);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { ok: false, reason: "missing" };
        return { ok: false, reason: "unreadable" };
      }
      if (!st.isFile() || modeIsWiderThanOwnerReadWrite(st.mode)) return { ok: false, reason: "insecure" };
      let raw = "";
      try {
        const fh = await open(file, "r");
        try {
          raw = await fh.readFile({ encoding: "utf8" });
        } finally {
          await fh.close();
        }
      } catch {
        return { ok: false, reason: "unreadable" };
      }
      const tokens = parseTokens(raw);
      if (!tokens) return { ok: false, reason: "unreadable" };
      return { ok: true, tokens };
    },
    async set(tokens) {
      const tmp = await stageTokenFile(file, tokenBody(tokens));
      try {
        await commitTokenFile(tmp, file);
      } catch (err) {
        // Log the errno only: the error text may carry paths, never token data.
        console.error("[afc] cursor token commit failed:", (err as NodeJS.ErrnoException).code ?? "unknown");
        await unlink(tmp).catch(() => { /* best-effort temp cleanup */ });
        throw new Error(msgTokenWrite());
      }
    },
    async delete() {
      await rm(file, { force: true });
    },
  };
}

/**
 * Reads `current`, falling back to `legacy` only when `current` does not exist. Writes always go to
 * `current`; the legacy file is left as it is. Disconnecting removes both.
 */
export function createMigratingTokenStore(current: string, legacy: string): TokenStore {
  const now = createFileTokenStore(current);
  const old = createFileTokenStore(legacy);
  return {
    async get() {
      const read = await now.get();
      if (read.ok || read.reason !== "missing") return read;
      return old.get();
    },
    set: (tokens) => now.set(tokens),
    async delete() {
      await now.delete();
      await old.delete();
    },
  };
}

export const cursorTokenStore: TokenStore = createMigratingTokenStore(CURSOR_TOKEN_FILE, LEGACY_CURSOR_TOKEN_FILE);
