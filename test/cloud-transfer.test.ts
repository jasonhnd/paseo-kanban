import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeCloudCommand, type CloudCommand } from "../server/cloud-command";
import { downloadFile, uploadFile } from "../server/cloud-transfer";
import { KanbanError } from "../server/errors";

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const remotePath = "$HOME/work/.kanban-work/DEMO_0001/task.bundle";
const limit = 10 * 1024 * 1024;

function fixture(t: { after(fn: () => void): void }, fault = "") {
  const root = mkdtempSync(join(tmpdir(), "cloud-transfer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "remote"); const bin = join(root, "bin");
  const card = join(home, "work/.kanban-work/DEMO_0001");
  mkdirSync(card, { recursive: true }); mkdirSync(bin);
  const log = join(root, "commands.jsonl"); const marker = join(root, "entered");
  const cli = join(bin, "instabox.cjs");
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== 'exec' || args[1] !== 'demo-machine' || args[2] !== '--') process.exit(2);
let command = args[3];
// The wire envelope is deliberately a single shell-quoted node command, with no stdin.
const match = command.match(/'({"id":.*})'$/);
if (!match) process.exit(3);
let input = JSON.parse(match[1]);
fs.appendFileSync(process.env.TRANSFER_LOG, JSON.stringify({op:input.op, seq:input.seq, length:Buffer.byteLength(command)})+'\\n');
const mode = process.env.TRANSFER_FAULT;
const chunk = input.op === 'upload-chunk' || input.op === 'download-chunk';
if (chunk && input.seq === 1 && mode === 'upload-corrupt' && input.op === 'upload-chunk') input.data = 'AAAA'+input.data.slice(4);
if (chunk && input.seq === 1 && mode === 'upload-order' && input.op === 'upload-chunk') input.seq++;
if (chunk && input.seq === 1 && mode === 'upload-drop' && input.op === 'upload-chunk') {
  console.log(JSON.stringify({id:input.id, op:input.op, seq:input.seq, bytes:input.bytes, sha256:input.sha256})); process.exit(0);
}
command = command.slice(0, match.index) + "'" + JSON.stringify(input) + "'";
const out = spawnSync('bash', ['-c', command], {env:{...process.env, HOME:process.env.TRANSFER_HOME}, encoding:'utf8', maxBuffer:1024*1024});
if (chunk && input.seq === 1 && mode === 'lost-ack' && !fs.existsSync(process.env.TRANSFER_MARKER)) {
  fs.writeFileSync(process.env.TRANSFER_MARKER, 'yes'); process.exit(1);
}
if (chunk && input.seq === 1 && mode === 'offline') process.exit(1);
if (chunk && input.seq === 1 && mode === 'cancel') {
  fs.writeFileSync(process.env.TRANSFER_MARKER, 'yes'); setTimeout(()=>process.exit(0), 30000);
} else {
  let stdout = out.stdout || '';
  if (input.op === 'download-chunk' && input.seq === 1) {
    if (mode === 'download-truncate') stdout = stdout.slice(0, -20);
    if (mode === 'download-drop') stdout = '';
    if (mode === 'download-corrupt' || mode === 'download-order') {
      const response = JSON.parse(stdout);
      if (mode === 'download-corrupt') response.data = 'AAAA'+response.data.slice(4);
      else response.seq++;
      stdout = JSON.stringify(response);
    }
  }
  process.stdout.write(stdout); process.stderr.write(out.stderr || ''); process.exit(out.status ?? 1);
}
`);
  chmodSync(cli, 0o755);
  symlinkSync(cli, join(bin, "instabox"));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRANSFER_HOME: home, TRANSFER_LOG: log, TRANSFER_FAULT: fault, TRANSFER_MARKER: marker };
  const exec: CloudCommand = (command, args, options) => executeCloudCommand(command, args, { ...options, env });
  return { root, card, marker, exec, localPath: join(root, "local.bundle"),
    commands: () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as {op: string; seq?: number; length: number}),
    clean: () => assert.deepEqual(readdirSync(card).filter(name => name.startsWith(".transfer-")), []),
  };
}

const isError = (code: string) => (error: unknown) => error instanceof KanbanError && error.code === code;

test("fake CLI transfers 3.5 MiB both ways, verifies digest and caps every full command at 60 KiB", async t => {
  const f = fixture(t); const data = randomBytes(3.5 * 1024 * 1024); writeFileSync(f.localPath, data);
  const expected = { bytes: data.length, sha256: digest(data) };
  assert.deepEqual(await uploadFile({machine: "demo-machine", localPath: f.localPath, remotePath, exec: f.exec, maxBytes: limit}), expected);
  assert.deepEqual(readFileSync(join(f.card, "task.bundle")), data);
  writeFileSync(f.localPath, "old destination");
  assert.deepEqual(await downloadFile({machine: "demo-machine", localPath: f.localPath, remotePath, exec: f.exec, maxBytes: limit}), expected);
  assert.deepEqual(readFileSync(f.localPath), data);
  assert(f.commands().every(command => command.length <= 61440));
  t.diagnostic(`largest full command: ${Math.max(...f.commands().map(command => command.length))} bytes`);
  assert(f.commands().filter(command => command.op === "upload-chunk").length > 100);
  f.clean();
});

for (const fault of ["upload-corrupt", "upload-drop", "upload-order", "download-corrupt", "download-drop", "download-order", "download-truncate", "offline"]) {
  test(`rejects ${fault}, cleans staging and preserves existing destination`, async t => {
    const f = fixture(t, fault); const data = randomBytes(100000);
    writeFileSync(f.localPath, fault.startsWith("download") ? "local original" : data);
    writeFileSync(join(f.card, "task.bundle"), fault.startsWith("download") ? data : "remote original");
    const action = fault.startsWith("download") ? downloadFile : uploadFile;
    await assert.rejects(action({machine:"demo-machine",localPath:f.localPath,remotePath,exec:f.exec,maxBytes:limit}), isError("cloud_transfer_corrupt"));
    if (action === uploadFile) assert.equal(readFileSync(join(f.card, "task.bundle"), "utf8"), "remote original");
    else assert.equal(readFileSync(f.localPath, "utf8"), "local original");
    f.clean(); assert(!readdirSync(f.root).some(name => name.includes(".transfer-")));
    if (fault === "offline") assert.equal(f.commands().filter(command => command.op === "upload-chunk" && command.seq === 1).length, 3);
  });
}

test("a lost acknowledgement retries the same upload block without duplicating bytes", async t => {
  const f = fixture(t, "lost-ack"); const data = randomBytes(100000); writeFileSync(f.localPath, data);
  await uploadFile({machine:"demo-machine",localPath:f.localPath,remotePath,exec:f.exec,maxBytes:limit});
  assert.deepEqual(readFileSync(join(f.card, "task.bundle")), data);
  assert.equal(f.commands().filter(command => command.op === "upload-chunk" && command.seq === 1).length, 2); f.clean();
});

for (const direction of ["upload", "download"] as const) {
  test(`${direction} rejects a file over maxBytes before any data block`, async t => {
    const f = fixture(t); writeFileSync(f.localPath, randomBytes(100)); writeFileSync(join(f.card, "task.bundle"), randomBytes(100));
    await assert.rejects((direction === "upload" ? uploadFile : downloadFile)({machine:"demo-machine",localPath:f.localPath,remotePath,exec:f.exec,maxBytes:99}), isError("cloud_transfer_too_large"));
    if (direction === "download") assert(!f.commands().some(command => command.op.endsWith("-chunk")));
    f.clean();
  });

  test(`${direction} aborts an in-flight CLI and cleans both staging areas`, async t => {
    const f = fixture(t, "cancel"); const controller = new AbortController();
    writeFileSync(f.localPath, direction === "upload" ? randomBytes(100000) : "local original");
    writeFileSync(join(f.card, "task.bundle"), direction === "upload" ? "remote original" : randomBytes(100000));
    const pending = assert.rejects((direction === "upload" ? uploadFile : downloadFile)({machine:"demo-machine",localPath:f.localPath,remotePath,exec:f.exec,signal:controller.signal,maxBytes:limit}), isError("cloud_transfer_aborted"));
    for (let i=0; !existsSync(f.marker) && i<500; i++) await new Promise(resolve=>setTimeout(resolve, 10));
    assert(existsSync(f.marker), "CLI reached in-flight second block"); controller.abort(); await pending;
    f.clean(); assert(!readdirSync(f.root).some(name => name.includes(".transfer-")));
    if (direction === "upload") assert.equal(readFileSync(join(f.card,"task.bundle"),"utf8"),"remote original");
    else assert.equal(readFileSync(f.localPath,"utf8"),"local original");
  });
}

test("already aborted transfers never start a CLI", async t => {
  const f = fixture(t); const signal = AbortSignal.abort();
  for (const action of [uploadFile, downloadFile]) await assert.rejects(action({machine:"demo-machine",localPath:f.localPath,remotePath,exec:async()=>{throw new Error("must not execute");},signal,maxBytes:limit}),isError("cloud_transfer_aborted"));
});

test("empty files round trip and custom chunks remain bounded", async t => {
  const f = fixture(t); writeFileSync(f.localPath, "");
  const expected = {bytes:0,sha256:digest(Buffer.alloc(0))};
  assert.deepEqual(await uploadFile({machine:"demo-machine",localPath:f.localPath,remotePath,exec:f.exec,maxBytes:0,chunkBytes:49152}),expected);
  assert.deepEqual(await downloadFile({machine:"demo-machine",localPath:f.localPath,remotePath,exec:f.exec,maxBytes:0}),expected); f.clean();
});

test("remote paths reject shell input, traversal and symlinks", async t => {
  const f=fixture(t); writeFileSync(f.localPath,"demo");
  for(const path of ["/tmp/source.bundle","$HOME/work/.kanban-work/DEMO_0001/../escape","$HOME/work/.kanban-work/DEMO_0001/a;echo"]){
    await assert.rejects(uploadFile({machine:"demo-machine",localPath:f.localPath,remotePath:path,exec:async()=>{throw new Error("must not execute");},maxBytes:limit}),isError("cloud_transfer_corrupt"));
  }
  const outside=join(f.root,"outside");mkdirSync(outside);symlinkSync(outside,join(f.card,"link"));
  await assert.rejects(uploadFile({machine:"demo-machine",localPath:f.localPath,remotePath:remotePath.replace("task.bundle","link/task.bundle"),exec:f.exec,maxBytes:limit}),isError("cloud_transfer_corrupt"));
  assert.deepEqual(readdirSync(outside),[]); f.clean();
});

test("a growing upload source hits the byte limit mid-transfer", async t => {
  const f=fixture(t); writeFileSync(f.localPath,randomBytes(70000));
  const exec: CloudCommand=async(command,args,options)=>{
    const result=await f.exec(command,args,options);
    if(args[3].includes('"op":"upload-init"')) writeFileSync(f.localPath,randomBytes(100001));
    return result;
  };
  await assert.rejects(uploadFile({machine:"demo-machine",localPath:f.localPath,remotePath,exec,maxBytes:100000}),isError("cloud_transfer_too_large"));
  assert(!existsSync(join(f.card,"task.bundle"))); f.clean();
});

test("whole-file digest rejects a changed source even when all block hashes are valid", async t => {
  const f=fixture(t); writeFileSync(f.localPath,randomBytes(70000));
  const exec: CloudCommand=async(command,args,options)=>{
    const result=await f.exec(command,args,options);
    if(args[3].includes('"op":"upload-init"')) writeFileSync(f.localPath,randomBytes(70000));
    return result;
  };
  await assert.rejects(uploadFile({machine:"demo-machine",localPath:f.localPath,remotePath,exec,maxBytes:limit}),isError("cloud_transfer_corrupt"));
  assert(!existsSync(join(f.card,"task.bundle"))); f.clean();
});

test("remote assembly verifies the full hash before replacing the destination", async t => {
  const f=fixture(t); writeFileSync(f.localPath,randomBytes(70000)); writeFileSync(join(f.card,"task.bundle"),"remote original");
  const exec: CloudCommand=async(command,args,options)=>{
    if(args[3].includes('"op":"upload-finish"')) {
      const scratch=readdirSync(f.card).find(name=>name.startsWith(".transfer-"))!;
      writeFileSync(join(f.card,scratch,"part-0"),randomBytes(32768));
    }
    return f.exec(command,args,options);
  };
  await assert.rejects(uploadFile({machine:"demo-machine",localPath:f.localPath,remotePath,exec,maxBytes:limit}),isError("cloud_transfer_corrupt"));
  assert.equal(readFileSync(join(f.card,"task.bundle"),"utf8"),"remote original"); f.clean();
});

test("download verifies whole-file hash beyond individual chunk hashes", async t => {
  const f=fixture(t); writeFileSync(join(f.card,"task.bundle"),randomBytes(70000));writeFileSync(f.localPath,"local original");
  const exec: CloudCommand=async(command,args,options)=>{
    const result=await f.exec(command,args,options);
    if(args[3].includes('"op":"download-init"')) { const response=JSON.parse(result.stdout);response.sha256="0".repeat(64);result.stdout=JSON.stringify(response); }
    return result;
  };
  await assert.rejects(downloadFile({machine:"demo-machine",localPath:f.localPath,remotePath,exec,maxBytes:limit}),isError("cloud_transfer_corrupt"));
  assert.equal(readFileSync(f.localPath,"utf8"),"local original"); f.clean();
});

test("provider truncation flags reject even syntactically complete JSON", async t => {
  const f=fixture(t); writeFileSync(join(f.card,"task.bundle"),randomBytes(70000));
  const exec: CloudCommand=async(command,args,options)=>{
    const result=await f.exec(command,args,options);
    return args[3].includes('"op":"download-chunk"') ? {...result,truncated:true} : result;
  };
  await assert.rejects(downloadFile({machine:"demo-machine",localPath:f.localPath,remotePath,exec,maxBytes:limit}),isError("cloud_transfer_corrupt"));
  f.clean(); assert(!existsSync(f.localPath));
});

test("a remote manifest over maxBytes is rejected before downloading data", async t => {
  const f=fixture(t); writeFileSync(join(f.card,"task.bundle"),randomBytes(100));
  const exec: CloudCommand=async(command,args,options)=>{
    const result=await f.exec(command,args,options);
    if(args[3].includes('"op":"download-init"')) { const response=JSON.parse(result.stdout);response.bytes=limit+1;result.stdout=JSON.stringify(response); }
    return result;
  };
  await assert.rejects(downloadFile({machine:"demo-machine",localPath:f.localPath,remotePath,exec,maxBytes:limit}),isError("cloud_transfer_too_large"));
  assert(!f.commands().some(command=>command.op==="download-chunk"));f.clean();
});

test("cleanup errors remain visible on the transfer error after bounded retries", async t => {
  const f=fixture(t); writeFileSync(f.localPath,randomBytes(70000));
  const exec: CloudCommand=async(command,args,options)=>{
    if(args[3].includes('"op":"cleanup"')) return {code:1,stdout:"",stderr:"cleanup unavailable"};
    const result=await f.exec(command,args,options);
    return args[3].includes('"op":"upload-chunk"') ? {...result,stdout:"truncated"} : result;
  };
  await assert.rejects(uploadFile({machine:"demo-machine",localPath:f.localPath,remotePath,exec,maxBytes:limit}),error=>isError("cloud_transfer_corrupt")(error) && (error as KanbanError).details.cleanupFailed===true);
});

test("concurrent uploads use separate staging and atomically deliver complete files", async t => {
  const f=fixture(t);const other=join(f.root,"other.bundle"),a=randomBytes(70000),b=randomBytes(90000);
  writeFileSync(f.localPath,a);writeFileSync(other,b);
  await Promise.all([f.localPath,other].map(localPath=>uploadFile({machine:"demo-machine",localPath,remotePath,exec:f.exec,maxBytes:limit,chunkBytes:1000000})));
  const result=readFileSync(join(f.card,"task.bundle"));assert(result.equals(a)||result.equals(b));
  assert(f.commands().every(command=>command.length<=61440));f.clean();
});
