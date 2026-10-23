import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CloudCommand } from "./cloud-command";
import { shellQuote } from "./cloud-script";
import { KanbanError } from "./errors";

export interface CloudTransferOptions {
  machine: string;
  localPath: string;
  /** Literal $HOME/work/.kanban-work/<CARD_CODE>/<file>, with safe path components. */
  remotePath: string;
  /** Pass the underlying CloudCommand; cleanup runs with a fresh, uncancelled signal. */
  exec: CloudCommand;
  signal?: AbortSignal;
  maxBytes: number;
}
export interface CloudTransferResult { bytes: number; sha256: string }

const COMMAND_LIMIT = 61_440;
// A requested 48 KiB block cannot fit the provider's 64 KiB command limit even with
// single-layer base64. Cap wire blocks at 32 KiB, leaving room for the worker below.
const WIRE_CHUNK_BYTES = 32_768;
const RETRIES = 3;
const CORRUPT = "cloud_transfer_corrupt";
const TOO_LARGE = "cloud_transfer_too_large";
const ABORTED = "cloud_transfer_aborted";

/** Executed by Node on the cloud template, never through stdin or a second base64 layer.
 * Private per-transfer directories make retries idempotent and concurrent transfers isolated.
 * Every path component is checked before access; rename is confined to the card scratch tree.
 */
const REMOTE_WORKER = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const input = JSON.parse(process.argv[1]);
const bad = () => { throw new Error("cloud_transfer_corrupt"); };
const large = () => { throw new Error("cloud_transfer_too_large"); };
const hash = b => crypto.createHash("sha256").update(b).digest("hex");
const size = n => { if (n > input.maxBytes) large(); };
const exists = p => { try { return fs.lstatSync(p); } catch(e) { if(e.code === "ENOENT") return null; throw e; } };
const home = fs.realpathSync(process.env.HOME);
function directory(p, create) {
  let st = exists(p);
  if (!st && create) { fs.mkdirSync(p, {mode:0o700}); st = fs.lstatSync(p); }
  if (st && (!st.isDirectory() || st.isSymbolicLink())) bad();
  return !!st;
}
function paths(create) {
  let p = home;
  const parts = ["work", ".kanban-work", ...input.relative.split("/")];
  for (const part of parts.slice(0,3)) {
    p = path.join(p,part);
    if (!directory(p,create)) return null;
  }
  const root = p;
  const scratch = path.join(root,".transfer-"+input.id);
  const scratchStat = exists(scratch);
  if (scratchStat && (!scratchStat.isDirectory() || scratchStat.isSymbolicLink())) bad();
  if(input.op === "cleanup") return {target:"",scratch};
  for (const part of parts.slice(3,-1)) {
    p = path.join(p,part);
    if (!directory(p,create)) return null;
  }
  const target = path.join(p,parts.at(-1));
  const st = exists(target);
  if (st && (!st.isFile() || st.isSymbolicLink())) bad();
  return {target,scratch};
}
function regular(p) { const st=fs.lstatSync(p); if(!st.isFile() || st.isSymbolicLink()) bad(); return st; }
function read(p) { regular(p); return fs.readFileSync(p,{flag:fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW}); }
function respond(value) { console.log(JSON.stringify({id:input.id,op:input.op,...value})); }
try {
  const p=paths(input.op.endsWith("-init"));
  if(input.op === "cleanup") {
    if(p && exists(p.scratch)) fs.rmSync(p.scratch,{recursive:true});
    respond({});
  } else {
    if(!p) bad();
    const {target,scratch}=p, statePath=path.join(scratch,"state.json"), dataPath=path.join(scratch,"data");
    const save=s => { fs.writeFileSync(statePath+".next",JSON.stringify(s),{mode:0o600}); fs.renameSync(statePath+".next",statePath); };
    if(input.op.endsWith("-init")) {
      fs.mkdirSync(scratch,{mode:0o700});
      if(input.op === "upload-init") {
        size(input.bytes);
        save({bytes:input.bytes,sha256:input.sha256,chunkBytes:input.chunkBytes,next:0});
        respond({bytes:input.bytes,sha256:input.sha256});
      } else {
        const st=regular(target); size(st.size);
        const src=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        let dest;
        try {
          dest=fs.openSync(dataPath,"wx",0o600);
          const digest=crypto.createHash("sha256"), buffer=Buffer.alloc(32768); let bytes=0,n;
          while((n=fs.readSync(src,buffer,0,buffer.length,null))>0) {
            bytes+=n; size(bytes); const block=buffer.subarray(0,n); digest.update(block); fs.writeFileSync(dest,block);
          }
          const state={bytes,sha256:digest.digest("hex"),chunkBytes:input.chunkBytes}; save(state); respond(state);
        } finally { fs.closeSync(src); if(dest !== undefined) fs.closeSync(dest); }
      }
    } else {
      const state=JSON.parse(read(statePath).toString()); size(state.bytes);
      const count=Math.ceil(state.bytes/state.chunkBytes);
      if(input.op.endsWith("-chunk")) {
        if(!Number.isSafeInteger(input.seq) || input.seq<0 || input.seq>=count) bad();
        const bytes=Math.min(state.chunkBytes,state.bytes-input.seq*state.chunkBytes);
        if(input.op === "upload-chunk") {
          if(input.seq>state.next || input.bytes!==bytes) bad();
          const block=Buffer.from(input.data,"base64");
          if(block.length!==bytes || block.toString("base64")!==input.data || hash(block)!==input.sha256) bad();
          const part=path.join(scratch,"part-"+input.seq);
          if(exists(part)) { if(!read(part).equals(block)) bad(); }
          else { fs.writeFileSync(part+".next",block,{mode:0o600}); fs.renameSync(part+".next",part); }
          if(input.seq===state.next) { state.next++; save(state); }
          respond({seq:input.seq,bytes,sha256:input.sha256});
        } else {
          const st=regular(dataPath); size(st.size); if(st.size!==state.bytes) bad();
          const fd=fs.openSync(dataPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW), block=Buffer.alloc(bytes);
          try { if(fs.readSync(fd,block,0,bytes,input.seq*state.chunkBytes)!==bytes) bad(); } finally { fs.closeSync(fd); }
          respond({seq:input.seq,bytes,sha256:hash(block),data:block.toString("base64")});
        }
      } else if(input.op === "upload-finish") {
        if(state.next!==count) bad();
        const fd=fs.openSync(dataPath,"wx",0o600), digest=crypto.createHash("sha256"); let bytes=0;
        try {
          for(let seq=0;seq<count;seq++) {
            const part=path.join(scratch,"part-"+seq), st=regular(part);
            if(st.size!==Math.min(state.chunkBytes,state.bytes-bytes)) bad();
            const block=read(part); bytes+=block.length; size(bytes); digest.update(block); fs.writeFileSync(fd,block);
          }
        } finally { fs.closeSync(fd); }
        if(bytes!==state.bytes || digest.digest("hex")!==state.sha256) bad();
        fs.renameSync(dataPath,target); fs.rmSync(scratch,{recursive:true}); respond({bytes,sha256:state.sha256});
      } else bad();
    }
  }
} catch(e) { respond({error:e.message === "cloud_transfer_too_large" ? e.message : "cloud_transfer_corrupt"}); }
`;

function failure(code = CORRUPT, details: Record<string, unknown> = {}): KanbanError {
  return new KanbanError(code, code === ABORTED ? "Cloud transfer cancelled" : code === TOO_LARGE ? "Cloud transfer exceeds byte limit" : "Cloud transfer integrity check failed", details);
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw failure(ABORTED); }
function validate(input: CloudTransferOptions, chunkBytes: number): string {
  checkAbort(input.signal);
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw failure();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(input.machine)) throw failure();
  const match = /^\$HOME\/work\/\.kanban-work\/([A-Z0-9]+_\d+\/(?:[a-zA-Z0-9][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9][a-zA-Z0-9_.-]*)$/.exec(input.remotePath);
  if (!match || Buffer.byteLength(input.remotePath) > 1024) throw failure();
  return match[1];
}
function manifest(value: Record<string, unknown>, maxBytes: number): CloudTransferResult {
  if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw failure();
  if (value.bytes > maxBytes) throw failure(TOO_LARGE);
  return { bytes: value.bytes, sha256: value.sha256 };
}
function equalManifest(actual: CloudTransferResult, expected: CloudTransferResult): void {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw failure();
}

function transport(input: CloudTransferOptions, relative: string) {
  const id = randomUUID();
  let started = false;
  const call = async (op: string, fields: Record<string, unknown> = {}, retries = 1, cleanup = false): Promise<Record<string, unknown>> => {
    const command = `node -e ${shellQuote(REMOTE_WORKER)} ${shellQuote(JSON.stringify({ id, op, relative, maxBytes: input.maxBytes, ...fields }))}`;
    if (Buffer.byteLength(command) > COMMAND_LIMIT) throw failure();
    for (let attempt = 0; attempt < retries; attempt++) {
      if (!cleanup) checkAbort(input.signal);
      started = true;
      let value: Record<string, unknown>;
      try {
        const result = await input.exec("instabox", ["exec", input.machine, "--", command], {
          env: process.env, signal: cleanup ? undefined : input.signal, timeoutMs: cleanup ? 5_000 : 30_000,
        });
        if (!cleanup) checkAbort(input.signal);
        // Raw CLI truncation notices fail JSON parsing; adapters may expose an explicit flag.
        if (result.code !== 0 || result.truncated || result.stderr.trim()) throw failure();
        value = JSON.parse(result.stdout);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
      } catch (error) {
        if (!cleanup) checkAbort(input.signal);
        if (attempt + 1 < retries) continue;
        throw error instanceof KanbanError ? error : failure();
      }
      if (value.id !== id || value.op !== op) throw failure();
      if (value.error) throw failure(value.error === TOO_LARGE ? TOO_LARGE : CORRUPT);
      return value;
    }
    throw failure();
  };
  return { call, cleanup: async () => { if (started) { await call("cleanup", {}, RETRIES, true); started = false; } } };
}

async function cleanup(transfer: ReturnType<typeof transport>, error: unknown, file?: FileHandle, partial?: string): Promise<void> {
  const details: Record<string, unknown> = {};
  try { await file?.close(); } catch { details.localCleanupFailed = true; }
  try { if (partial) await rm(partial, { force: true }); } catch { details.localCleanupFailed = true; }
  try { await transfer.cleanup(); } catch { details.cleanupFailed = true; }
  if (Object.keys(details).length) {
    if (error instanceof KanbanError) Object.assign(error.details, details);
    else throw failure(CORRUPT, details);
  }
}

async function hashSource(file: FileHandle, maxBytes: number, signal?: AbortSignal): Promise<CloudTransferResult> {
  const info = await file.stat();
  if (!info.isFile()) throw failure();
  if (info.size > maxBytes) throw failure(TOO_LARGE);
  const digest = createHash("sha256"), buffer = Buffer.alloc(WIRE_CHUNK_BYTES); let bytes = 0;
  while (true) {
    checkAbort(signal);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, bytes);
    if (!bytesRead) break;
    bytes += bytesRead; if (bytes > maxBytes) throw failure(TOO_LARGE);
    digest.update(buffer.subarray(0, bytesRead));
  }
  return { bytes, sha256: digest.digest("hex") };
}

/** Upload in bounded, idempotent blocks. Only a verified complete file replaces remotePath. */
export async function uploadFile(input: CloudTransferOptions & { chunkBytes?: number }): Promise<CloudTransferResult> {
  const chunkBytes = Math.min(input.chunkBytes ?? 49_152, WIRE_CHUNK_BYTES);
  const relative = validate(input, input.chunkBytes ?? 49_152), transfer = transport(input, relative);
  let file: FileHandle | undefined; let error: unknown;
  try {
    file = await open(input.localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const expected = await hashSource(file, input.maxBytes, input.signal);
    equalManifest(manifest(await transfer.call("upload-init", { ...expected, chunkBytes }), input.maxBytes), expected);
    const buffer = Buffer.alloc(chunkBytes); let bytes = 0; let seq = 0;
    const digest = createHash("sha256");
    while (true) {
      checkAbort(input.signal);
      if ((await file.stat()).size > input.maxBytes) throw failure(TOO_LARGE);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > input.maxBytes) throw failure(TOO_LARGE);
      if (bytes > expected.bytes) throw failure();
      const block = buffer.subarray(0, bytesRead), sha256 = createHash("sha256").update(block).digest("hex");
      digest.update(block);
      const ack = await transfer.call("upload-chunk", { seq, bytes: bytesRead, sha256, data: block.toString("base64") }, RETRIES);
      if (ack.seq !== seq) throw failure();
      equalManifest(manifest(ack, input.maxBytes), { bytes: bytesRead, sha256 }); seq++;
    }
    equalManifest({ bytes, sha256: digest.digest("hex") }, expected);
    equalManifest(manifest(await transfer.call("upload-finish"), input.maxBytes), expected);
    return expected;
  } catch (caught) { error = input.signal?.aborted ? failure(ABORTED) : caught instanceof KanbanError ? caught : failure(); throw error; }
  finally { await cleanup(transfer, error, file); }
}

/** Download a bounded remote snapshot, then verify it before atomically replacing localPath. */
export async function downloadFile(input: CloudTransferOptions): Promise<CloudTransferResult> {
  const relative = validate(input, WIRE_CHUNK_BYTES), transfer = transport(input, relative);
  const partial = join(dirname(input.localPath), `.${basename(input.localPath)}.transfer-${randomUUID()}`);
  let file: FileHandle | undefined; let created = false; let error: unknown;
  try {
    const expected = manifest(await transfer.call("download-init", { chunkBytes: WIRE_CHUNK_BYTES }), input.maxBytes);
    file = await open(partial, "wx", 0o600); created = true;
    const digest = createHash("sha256"); let bytes = 0;
    for (let seq = 0; bytes < expected.bytes; seq++) {
      const response = await transfer.call("download-chunk", { seq }, RETRIES);
      const length = Math.min(WIRE_CHUNK_BYTES, expected.bytes - bytes);
      if (response.seq !== seq || response.bytes !== length || typeof response.data !== "string" || response.data.length !== Math.ceil(length / 3) * 4) throw failure();
      const block = Buffer.from(response.data, "base64");
      if (block.length !== length || block.toString("base64") !== response.data) throw failure();
      equalManifest(manifest(response, input.maxBytes), { bytes: length, sha256: createHash("sha256").update(block).digest("hex") });
      bytes += block.length; if (bytes > input.maxBytes) throw failure(TOO_LARGE);
      digest.update(block); await file.writeFile(block);
    }
    equalManifest({ bytes, sha256: digest.digest("hex") }, expected);
    await file.close(); file = undefined;
    // Remove remote staging before committing the local destination, so failed cleanup fails closed.
    await transfer.cleanup(); checkAbort(input.signal);
    await rename(partial, input.localPath); created = false;
    return expected;
  } catch (caught) { error = input.signal?.aborted ? failure(ABORTED) : caught instanceof KanbanError ? caught : failure(); throw error; }
  finally { await cleanup(transfer, error, file, created ? partial : undefined); }
}
