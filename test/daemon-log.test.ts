/// <reference types="node" />
import { zhCN, zhCNPart } from "./helpers/locale";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { foldEpisode, markerFromLine, markersIn, observeDaemon, takeLogChunk, takeLogChunkBytes } from "../server/daemon-log";

const tmp = tmpdir();
const dir = mkdtempSync(join(tmp, "daemon-log-"));
process.env.KANBAN_DATA_DIR = dir;

const crashAt = "2026-09-28T00:45:42.311Z";
const readyAt = "2026-09-28T00:45:47.478Z";
const laterAt = "2026-09-28T01:00:00.000Z";

function line(row: unknown): string {
  return `${JSON.stringify(row)}\n`;
}

function crashed(time: string): string {
  return line({ level: "info", time, name: "DaemonRunner", msg: "Worker crashed (code 1). Restarting worker..." });
}

function ready(time: string): string {
  return line({ level: "info", time, name: "DaemonRunner", msg: "Worker ready" });
}

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function useData(): void {
  process.env.KANBAN_DATA_DIR = mkdtempSync(join(dir, "data-"));
}

describe("daemon restart log", { concurrency: 1 }, () => {
  it("recognizes Worker crashed, Worker ready, and a level-60 daemon crashing line", () => {
    const fatalMs = Date.parse("2026-09-28T00:45:42.079Z");
    assert.equal(markerFromLine(line({ level: 60, time: fatalMs, msg: "Uncaught exception — daemon crashing" })), new Date(fatalMs).toISOString());
    assert.equal(markerFromLine(crashed(crashAt).trim()), new Date(Date.parse(crashAt)).toISOString());
    assert.equal(markerFromLine(ready(readyAt).trim()), new Date(Date.parse(readyAt)).toISOString());
    assert.equal(markerFromLine(line({ level: "info", time: crashAt, msg: "Spawning worker" })), null);
    assert.equal(markerFromLine("not json"), null);
    assert.equal(markerFromLine(line({ level: 60, msg: "Uncaught exception — daemon crashing" })), null);
    const chunk = ["(node:1) Warning: ignored", crashed(crashAt).trim(), ready(readyAt).trim()].join("\n") + "\n";
    assert.deepEqual(markersIn(chunk), [new Date(Date.parse(crashAt)).toISOString(), new Date(Date.parse(readyAt)).toISOString()]);
  });

  it("keeps markers within two minutes as one restart and does not rewind", () => {
    const first = foldEpisode(null, crashAt);
    const same = foldEpisode(first, readyAt);
    assert.equal(same?.id, first?.id);
    assert.equal(same?.at, new Date(Date.parse(readyAt)).toISOString());
    const next = foldEpisode(same, laterAt);
    assert.equal(next?.id, new Date(Date.parse(laterAt)).toISOString());
    assert.equal(foldEpisode(next, crashAt)?.id, next?.id);
  });

  it("reads only the new bytes, and starts over when the file shrinks or is replaced", () => {
    useData();
    const logPath = join(dir, "daemon.log");
    const pidPath = join(dir, "missing.pid");
    writeFileSync(logPath, crashed(crashAt));
    const first = observeDaemon({ logPath, pidPath });
    assert.equal(first.fromStart, true);
    assert.equal(first.markers, 1);
    assert.equal(first.chunkBytes, Buffer.byteLength(crashed(crashAt)));
    assert.equal(first.episode?.at, new Date(Date.parse(crashAt)).toISOString());

    const noise = line({ level: 30, time: crashAt, msg: "still listening" });
    writeFileSync(logPath, noise, { flag: "a" });
    const second = observeDaemon({ logPath, pidPath });
    assert.equal(second.fromStart, false);
    assert.equal(second.markers, 0);
    assert.equal(second.chunkBytes, Buffer.byteLength(noise));
    assert.equal(second.episode?.id, first.episode?.id);

    writeFileSync(logPath, ready(readyAt), { flag: "a" });
    const third = observeDaemon({ logPath, pidPath });
    assert.equal(third.fromStart, false);
    assert.equal(third.markers, 1);
    assert.equal(third.chunkBytes, Buffer.byteLength(ready(readyAt)));
    assert.equal(third.episode?.id, first.episode?.id);
    assert.equal(third.episode?.at, new Date(Date.parse(readyAt)).toISOString());

    writeFileSync(logPath, ready(laterAt));
    const shrunk = observeDaemon({ logPath, pidPath });
    assert.equal(shrunk.fromStart, true);
    assert.equal(shrunk.markers, 1);
    assert.equal(shrunk.episode?.id, new Date(Date.parse(laterAt)).toISOString());

    rmSync(logPath);
    const replacedAt = "2026-09-28T02:00:00.000Z";
    writeFileSync(logPath, crashed(replacedAt));
    const replaced = observeDaemon({ logPath, pidPath });
    assert.equal(replaced.fromStart, true);
    assert.equal(replaced.episode?.at, new Date(Date.parse(replacedAt)).toISOString());
  });

  it("keeps the byte offset when a line contains an em dash and Chinese", () => {
    useData();
    const logPath = join(dir, "utf8.log");
    const pidPath = join(dir, "utf8-missing.pid");
    const body =
      line({ level: 60, time: Date.parse(crashAt), msg: "Uncaught exception — daemon crashing" }) +
      line({ level: 30, time: crashAt, msg: ("[paseo-kanban] " + zhCN("doctor.object.plugin") + zhCNPart("dispatch.prompt.readOnly", 34, 36) + zhCNPart("compat.skip.restartMarker", 4, 6) + "Demo text") });
    writeFileSync(logPath, body);
    const size = statSync(logPath).size;
    assert.ok(size > body.length);
    const first = observeDaemon({ logPath, pidPath });
    assert.equal(first.fromStart, true);
    assert.equal(first.markers, 1);
    assert.equal(first.chunkBytes, size);
    const second = observeDaemon({ logPath, pidPath });
    assert.equal(second.fromStart, false);
    assert.equal(second.chunkBytes, 0);
    assert.equal(second.markers, 0);
    const data = process.env.KANBAN_DATA_DIR;
    assert.ok(data);
    const saved = JSON.parse(readFileSync(join(data, "daemon-restart.json"), "utf8")) as { offset: number };
    assert.equal(saved.offset, size);
  });

  it("holds a partial last line and uses paseo.pid startedAt when the log has no marker", () => {
    useData();
    const logPath = join(dir, "partial.log");
    const pidPath = join(dir, "paseo.pid");
    const partial = crashed(crashAt).trimEnd();
    writeFileSync(logPath, partial);
    const held = observeDaemon({ logPath, pidPath });
    assert.equal(held.markers, 0);
    assert.equal(held.episode, null);
    writeFileSync(logPath, `${partial}\n`);
    const done = observeDaemon({ logPath, pidPath });
    assert.equal(done.markers, 1);
    assert.equal(done.episode?.at, new Date(Date.parse(crashAt)).toISOString());

    const quiet = join(dir, "quiet.log");
    writeFileSync(quiet, line({ level: 30, time: crashAt, msg: "hello" }));
    const startedAt = "2026-09-28T03:10:00.000Z";
    writeFileSync(pidPath, `${JSON.stringify({ pid: 1, startedAt })}\n`);
    const fromPid = observeDaemon({ logPath: quiet, pidPath });
    assert.equal(fromPid.markers, 0);
    assert.equal(fromPid.episode?.at, new Date(Date.parse(startedAt)).toISOString());
  });

  it("counts the file offset from the last newline byte, not the decoded string", () => {
    const buf = Buffer.concat([Buffer.from([0xe4, 0xb8]), Buffer.from((zhCNPart("flow.nudge.blocked", 11, 12) + "\nkept"))]);
    const taken = takeLogChunkBytes(buf);
    const nl = buf.lastIndexOf(0x0a);
    assert.equal(taken.nextOffset, nl + 1);
    assert.equal(taken.chunk.equals(buf.subarray(0, nl + 1)), true);
    const decoded = buf.toString("utf8");
    const viaString = Buffer.byteLength(decoded.slice(0, decoded.lastIndexOf("\n") + 1));
    assert.notEqual(viaString, taken.nextOffset);

    useData();
    const logPath = join(dir, "bytes.log");
    const pidPath = join(dir, "bytes-missing.pid");
    writeFileSync(logPath, buf);
    const first = observeDaemon({ logPath, pidPath });
    assert.equal(first.chunkBytes, nl + 1);
    const data = process.env.KANBAN_DATA_DIR;
    assert.ok(data);
    const saved = JSON.parse(readFileSync(join(data, "daemon-restart.json"), "utf8")) as { offset: number };
    assert.equal(saved.offset, nl + 1);
  });

  it("treats an offset past the end as a start-over for the pure chunk helper", () => {
    const text = crashed(crashAt);
    const taken = takeLogChunk(text, text.length + 10);
    assert.equal(taken.fromStart, true);
    assert.equal(taken.chunk, text);
  });
});
