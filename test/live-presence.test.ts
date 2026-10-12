/// <reference types="node" />
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { livePresence } from "../server/live-presence";

const dir = mkdtempSync(join(tmpdir(), "kanban-live-presence-"));
process.env.KANBAN_AGENTS_DIR = join(dir, "agents");
mkdirSync(process.env.KANBAN_AGENTS_DIR, { recursive: true });

after(() => {
  delete process.env.KANBAN_AGENTS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** A loopback port nothing listens on: bind to 0, read the port, close. */
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("live presence", () => {
  it("falls back to the record file and logs when the daemon cannot be reached", async () => {
    const port = await unusedPort();
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const presence = await livePresence("no-such-agent", { PASEO_URL: `ws://127.0.0.1:${port}/ws` });
      assert.equal(presence, "unknown");
    } finally {
      console.error = original;
    }
    assert.equal(errors.some((args) => args[0] === "[paseo-kanban] presence"), true);
  });
});
