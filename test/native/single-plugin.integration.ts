// Explicit real public host validation. Run in the anonymous test environment with PASEO_SERVER_DIR.
// Registration/unload and DOM mounting are separate tests. This never attaches to an installed daemon.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { isolatedEnvironment } from "../../scripts/isolated-environment.mjs";
import { LIGHT_THEME, DARK_THEME } from "../helpers/theme-fixture";
import { translate } from "../../shared/i18n";

const source = resolve(import.meta.dirname, "../..");
const serverRoot = process.env.PASEO_SERVER_DIR;
if (!serverRoot) throw new Error("PASEO_SERVER_DIR must name the separately installed public host package");
const runtimePath = join(serverRoot, "dist/server/server/plugins/runtime.js");
const workerPath = realpathSync(join(serverRoot, "dist/server/server/plugins/plugin-process.js"));
const { PluginRuntime } = await import(pathToFileURL(runtimePath).href);
const { WebSocketServer } = createRequire(import.meta.url)("ws");
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(ready: () => boolean, detail: string): Promise<void> {
  const limit = Date.now() + 15_000;
  while (!ready()) { assert.ok(Date.now() < limit, detail); await pause(); }
}

// Only empty, anonymous providers/agents are offered by this local protocol fixture.
function reply(data: string, send: (data: string) => void): void {
  const envelope = JSON.parse(data);
  const msg = envelope.message ?? envelope;
  const respond = (type: string, payload: unknown) => send(JSON.stringify({ type: "session", message: { type, payload } }));
  const requestId = msg.requestId ?? msg.payload?.requestId;
  if (envelope.type === "hello") {
    respond("status", { status: "server_info", serverId: "anonymous-local-host", protocolVersion: 1, version: "0.11.0", features: {} });
  } else if (msg.type === "ping") {
    if (requestId) respond("pong", { requestId, clientSentAt: msg.clientSentAt, serverReceivedAt: Date.now(), serverSentAt: Date.now() });
    else send(JSON.stringify({ type: "pong" }));
  } else if (msg.type === "provider.usage.list.request") {
    respond("provider.usage.list.response", { requestId, fetchedAt: new Date().toISOString(), providers: [] });
  } else if (msg.type === "list_available_providers_request") {
    respond("list_available_providers_response", { requestId, fetchedAt: new Date().toISOString(), providers: [] });
  } else if (requestId) {
    respond("rpc_error", { requestId, requestType: msg.type, error: "Anonymous host has no agents, workspaces or providers" });
  }
}

async function withRuntime(work: (fixture: any) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "single-plugin-host-"));
  const env = isolatedEnvironment(dir);
  // Prevent platform probes even on Darwin. Empty config contains no provider/profile identities.
  env.KANBAN_TEST_TMP = dir;
  const socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => socketServer.once("listening", resolve));
  const address = socketServer.address();
  assert.equal(typeof address, "object");
  env.PASEO_URL = `ws://127.0.0.1:${address.port}/ws`;
  socketServer.on("connection", (socket: any) => socket.on("message", (data: Buffer) => reply(data.toString(), data => socket.send(data))));
  await writeFile(env.KANBAN_PASEO_CONFIG!, JSON.stringify({ daemon: { agentProfiles: [], listen: `127.0.0.1:${address.port}` }, plugins: {} }));
  await mkdir(join(env.KANBAN_DATA_DIR!, "fleet"));
  await writeFile(join(env.KANBAN_DATA_DIR!, "fleet/plans.json"), JSON.stringify({ schemaVersion: 2, plans: [], dispatchPriority: null }));
  await writeFile(join(env.KANBAN_DATA_DIR!, "fleet/afc.config.json"), JSON.stringify({ adapters: { "cursor-api": false, keychain: false, "antigravity-cli": false, "grok-cli": false }, bannedProviders: [] }));
  const ledger = join(dir, "timer-ledger.json");
  const preload = join(dir, "timer-ledger.mjs");
  await writeFile(preload, `
    import {writeFileSync} from 'node:fs';
    const active=new Set(), interval=globalThis.setInterval, clear=globalThis.clearInterval;
    globalThis.setInterval=(...args)=>{const timer=interval(...args);active.add(timer);return timer;};
    globalThis.clearInterval=timer=>{active.delete(timer);return clear(timer);};
    process.on('exit',()=>writeFileSync(${JSON.stringify(ledger)},JSON.stringify({intervals:active.size})));
  `);
  let child: any, ready: any, exit: { code: number | null; signal: string | null } | null = null;
  const logger: any = { child: () => logger, debug() {}, info() {}, warn() {}, error() {} };
  const runtime = new PluginRuntime(logger, "0.11.0", {
    spawnChild() {
      child = fork(workerPath, [], { env, cwd: source, execArgv: ["--import", preload], serialization: "advanced", stdio: ["ignore", "pipe", "pipe", "ipc"] });
      child.on("message", (msg: any) => { if (msg.type === "ready") ready = msg; });
      child.on("exit", (code: number | null, signal: string | null) => { exit = { code, signal }; });
      return child;
    },
    sessionHost: { async attachPluginSocket(id: string, socket: any) {
      assert.equal(id, "paseo-kanban");
      socket.on("message", (data: string | Buffer) => reply(data.toString(), data => socket.send(data)));
      return { closed: new Promise<void>(resolve => socket.once("close", resolve)) };
    } },
  });
  try {
    await runtime.startPlugin("paseo-kanban", source);
    await until(() => !!ready, "actual worker ready");
    const invoke = (name: string, input: unknown) => runtime.invoke("paseo-kanban", name, input);
    await work({ runtime, invoke, ready, env, dir, stop: () => runtime.stopPluginById("paseo-kanban") });
    if (runtime.catalog().length) await runtime.stopPluginById("paseo-kanban");
    assert.deepEqual(exit, { code: 0, signal: null }, "cleanup must exit naturally before the host force timer");
    assert.deepEqual(JSON.parse(await readFile(ledger, "utf8")), { intervals: 0 }, "all real worker intervals are released");
  } catch (error) {
    console.error(runtime.getLogs("paseo-kanban").map((entry: any) => entry.message).join("\n"));
    throw error;
  } finally {
    await runtime.stopPluginById("paseo-kanban").catch(() => undefined);
    if (child && exit === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); }
    for (const client of socketServer.clients) client.terminate();
    await new Promise<void>(resolve => socketServer.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test("actual host registers one plugin and both RPC families, then releases every interval", async () => {
  await withRuntime(async ({ runtime, ready, invoke, env, stop }) => {
    assert.deepEqual(runtime.catalog().map((row: any) => row.id), ["paseo-kanban"]);
    assert.deepEqual(ready.providers, []);
    assert.equal(new Set(ready.methods).size, ready.methods.length);
    for (const name of ["kanban.board", "kanban.config.read", "board.roles-page", "board.snapshot", "config.read"]) assert.ok(ready.methods.includes(name), name);
    assert.equal(ready.hooks.events.filter((name: string) => name === "agent.turn_ended").length, 1);
    await assert.rejects(() => runtime.startPlugin("paseo-kanban", source), /already running/);
    assert.equal((await invoke("kanban.board", {})).tasks.length, 0);
    assert.equal((await invoke("board.roles-page", {})).cards.length > 0, true);
    assert.equal((await invoke("config.read", { file: "plans" })).document.plans.length, 0);
    await until(() => runtime.getLogs("paseo-kanban").some((entry: any) => entry.message.includes("mcp")), "MCP started");
    const port = Number(await readFile(join(env.KANBAN_DATA_DIR, "mcp.port"), "utf8"));
    assert.ok(port > 0);
    assert.equal(await stop(), true);
    assert.deepEqual(runtime.catalog(), []);
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/mcp`));
  });
});

test("actual compiled client mounts board/workspace and Fleet tabs, shares settings and host theme", async () => {
  await withRuntime(async ({ runtime, invoke, dir }) => {
    const { JSDOM } = createRequire(import.meta.url)("jsdom");
    const dom = new JSDOM("<html><body></body></html>", { pretendToBeVisual: true, url: "https://example.invalid" });
    const global = globalThis as any;
    for (const key of Object.getOwnPropertyNames(dom.window)) if (!(key in global)) try { global[key] = dom.window[key]; } catch { /* read-only browser property */ }
    global.window = dom.window; global.document = dom.window.document;
    Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });
    global.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0); global.cancelAnimationFrame = clearTimeout;
    global.__compiledClient = runtime.catalog()[0].clientBundle;
    const calls: Array<{ name: string; input: any }> = [];
    global.__hostInvoke = async (name: string, input: unknown) => { calls.push({ name, input }); return invoke(name, input); };
    const outfile = join(dir, "client-host.mjs");
    await build({ stdin: { contents: `
      import React from 'react';import * as jsx from 'react/jsx-runtime';import {createRoot} from 'react-dom/client';
      import * as RN from 'react-native';import * as query from '@tanstack/react-query';import * as sdk from '@getpaseo/plugin';import * as zod from 'zod';
      const methods=new Map();const host={useRpc:rpc=>{if(!methods.has(rpc.name))methods.set(rpc.name,input=>globalThis.__hostInvoke(rpc.name,rpc.input.parse(input)).then(result=>rpc.output.parse(result)));return methods.get(rpc.name);},useWorkspace:(_id,select)=>select({projectRootPath:'/anonymous/demo',projectDisplayName:'Demo'})};
      const clientUi={SidebarRow:props=>React.createElement(RN.Pressable,{onPress:props.onPress,'aria-label':'Paseo Kanban sidebar'},React.createElement(RN.Text,null,'Paseo Kanban'))};
      const modules={'react':React,'react/jsx-runtime':jsx,'react-native':RN,'@getpaseo/plugin/client/react-native':RN,'@tanstack/react-query':query,'@getpaseo/plugin':sdk,'@getpaseo/plugin/client':host,'@getpaseo/plugin/client/ui':clientUi,'zod':zod};
      const exports=(0,eval)(globalThis.__compiledClient)(name=>{if(!(name in modules))throw new Error('Unexpected client dependency '+name);return modules[name];});
      const surfaces=new Map(),events=[];const add=kind=>row=>{const key=kind+':'+row.id;if(surfaces.has(key))throw new Error('duplicate surface '+key);surfaces.set(key,row);events.push(['add',key]);return()=>{surfaces.delete(key);events.push(['remove',key]);};};
      const dispose=exports.default({addScreen:add('screen'),addSidebarItem:add('sidebar'),addWorkspacePanel:add('workspace'),addSettingsScreen:add('settings')});
      export {surfaces,events,dispose};
      export function mount(kind,theme){const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);const client=new query.QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
        const Component=surfaces.get(kind+':board').Component;const props={theme,layout:{compact:false,platform:'web'},workspaceId:'anonymous-workspace',host:{id:'anonymous-local-host',label:'Anonymous'},navigation:{openAgent(){},openWorkspace(){}}};
        const update=theme=>root.render(React.createElement(query.QueryClientProvider,{client},React.createElement(Component,{...props,theme})));
        update(theme);return {container,update,unmount:()=>{root.unmount();client.clear();container.remove();}};}
    `, resolveDir: source, loader: "tsx", sourcefile: "anonymous-client-host.tsx" }, bundle: true, platform: "node", format: "esm", outfile, jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" }, alias: { "react-native": "react-native-web" }, logLevel: "error",
      banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    });
    const host = await import(pathToFileURL(outfile).href);
    let mounted: any;
    try {
      assert.deepEqual([...host.surfaces.keys()].sort(), ["screen:board", "settings:config", "sidebar:board", "workspace:board"]);
      mounted = host.mount("workspace", LIGHT_THEME);
      await until(() => calls.some(call => call.name === "kanban.board"), "workspace board read");
      assert.equal(calls.find(call => call.name === "kanban.board")?.input.project, "demo", "workspace project lock is preserved");
      await pause(150);
      // Application tabs use accessibility selected state; inspect the unique labels on the top row.
      const row = mounted.container.firstElementChild.firstElementChild;
      const buttons = () => [...row.querySelectorAll('[role="button"]')] as any[];
      assert.equal(buttons().length, 9, "one board + seven Fleet panels + one settings tab");
      for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) { buttons()[index].click(); await pause(180); }
      for (const name of ["board.snapshot", "board.roles-page", "board.usage", "board.access", "config.read", "kanban.config.read"]) assert.ok(calls.some(call => call.name === name), name);
      assert.equal(mounted.container.querySelectorAll('[role="tab"]').length, 0, "integrated Fleet does not add a second tab bar");
      assert.ok(mounted.container.textContent.includes("Language"), "combined settings contain the shared language control");
      const languageOption = [...mounted.container.querySelectorAll('[role="radio"]')].find((node: any) => node.getAttribute("aria-label")?.endsWith("Chinese")) as any;
      assert.ok(languageOption, "shared language setting is rendered");
      languageOption.click(); await pause();
      const save = [...mounted.container.querySelectorAll('[role="button"]')].find((node: any) => node.getAttribute("aria-label") === "Save") as any;
      assert.ok(save); save.click();
      await until(() => buttons()[0].getAttribute("aria-label") === translate("zh-CN", "application.board"), "shared navbar repaints after the language setting is saved");
      buttons()[5].click(); await pause(120);
      assert.equal(buttons()[0].getAttribute("aria-label"), translate("zh-CN", "application.board"), "cached Fleet preferences cannot revert the shared language");
      mounted.update(DARK_THEME); await pause(120);
      const normalize = (value: string) => { const element = dom.window.document.createElement("div"); element.style.color = value; return element.style.color; };
      assert.equal(dom.window.getComputedStyle(mounted.container.firstElementChild).backgroundColor, normalize(DARK_THEME.colors.surface0));
      buttons()[0].click(); await pause(120);
      assert.equal(calls.filter(call => call.name === "kanban.board").every(call => call.input.project === "demo"), true);
      mounted.unmount(); mounted = null;
      host.dispose(); assert.equal(host.surfaces.size, 0);
      assert.equal(host.events.filter((row: string[]) => row[0] === "add" && row[1] === "sidebar:board").length, 1);
    } finally {
      mounted?.unmount(); host.dispose(); dom.window.close();
      delete global.__hostInvoke; delete global.__compiledClient;
    }
  });
});
