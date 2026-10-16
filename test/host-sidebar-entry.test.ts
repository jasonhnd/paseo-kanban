/// <reference types="node" />
// Registers the real client on the public Paseo 0.11.2 host (app or explicit npm runtime). Desktop and compact
// layouts mount its SidebarRow, preserving the old sidebar/surface deep links.
// This mounted host harness complements the separate actual Edge validation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { after, before, describe, it } from "node:test";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PANEL_TAB_IDS, panelTabLabel } from "../shared/fleet/panel-tabs";
import { getLanguage, t } from "../shared/i18n";
import { THRESHOLD_KEYS, settingsReadSchema } from "../shared/settings";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { default: contribute } = await import("../index.client");

const HOST_VERSION = "0.11.2";
const PUBLIC_APP = "/Applications/Paseo.app";
const PLUGIN_ID = "paseo-kanban";
const SCREEN_ID = "board";
const START_URL = "https://example.invalid/h/local";
const SIDEBAR_TEST_ID = "plugin-sidebar-paseo-kanban-board";
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));

type HostPlugin = {
  id: string;
  cleanup: () => Promise<void>;
  surfaces: Array<{ id: string; title: string }>;
  settingsScreens: Array<{ id: string; title: string; icon: string }>;
  sidebarItems: { header: Array<{ id: string; title: string; Component: unknown }>; footer: unknown[] };
  commandCenterItems: Array<{ id: string; title: string; context: string; onSelect: (context: unknown) => void }>;
  legacySidebarItems: Array<{ id: string; title: string; icon: string; surface: string }>;
  workspacePanels: Array<{ id: string; title: string; icon: string; context: string }>;
};

type HostComponent = abstract new (...args: never[]) => {
  props: { children?: unknown };
  state: { error: string };
  setState(value: { error: string }): void;
};

type HostReact = {
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;
  useState: <T>(value: T) => [T, (update: T | ((value: T) => T)) => void];
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void;
  Component: HostComponent;
  version: string;
};

type DomNode = {
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): DomNode[];
  textContent: string | null;
  remove(): void;
  click(): void;
};

type MediaListener = (event: { matches: boolean; media: string }) => void;

type MediaStub = {
  matches: boolean;
  media: string;
  addListener: (listener: MediaListener) => void;
  removeListener: (listener: MediaListener) => void;
  addEventListener: (type: string, listener: MediaListener) => void;
  removeEventListener: (type: string, listener: MediaListener) => void;
  dispatchEvent: () => boolean;
  onchange: MediaListener | null;
};

type ScreenStub = {
  width: number;
  height: number;
  orientation: { type: string; angle: number; addEventListener: () => void; removeEventListener: () => void };
};

type PageError = { message?: string; error?: { message?: string }; preventDefault?: () => void };

type DomWindow = {
  document: {
    createElement(tag: string): DomNode;
    body: { appendChild(node: DomNode): void };
  };
  location: { href: string; pathname: string; search: string };
  history: {
    pushState: (...args: unknown[]) => void;
    replaceState: (...args: unknown[]) => void;
  };
  navigator: object;
  matchMedia: (query: string) => MediaStub;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  screen: ScreenStub;
  requestAnimationFrame: (callback: (time: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
  addEventListener(type: string, listener: (event: PageError) => void): void;
  dispatchEvent(event: Event): boolean;
  Event: new (type: string) => Event;
  fetch: (...args: unknown[]) => Promise<unknown>;
  close(): void;
};

type SidebarGroup = { kind: string; pluginId: string; contributionId: string; title: string; icon: string };

type NavItem = { kind: string; key: string; visible: boolean };

type CatalogPlugin = {
  id?: string;
  legacySidebarItems?: unknown[];
  sidebarItems?: { header: unknown[]; footer: unknown[] };
  workspacePanels?: Array<{ id?: string; context?: string }>;
};

type ExpoStore = {
  navigationRef: { current: unknown; isReady?: () => boolean };
  state: unknown;
  linking: unknown;
  onReady?: () => void;
};

type BuiltNav = {
  state: { routes: Array<{ key: string }>; index: number };
  descriptors: Record<string, { render: () => unknown }>;
  NavigationContent: unknown;
};

type HostController = {
  getSnapshot: () => { client: { serverId: string }; connectionStatus: string; serverId: string };
  getClient: () => { serverId: string };
};

type Shell = {
  registry: {
    installCatalog: (serverId: string, plugins: unknown[], services: unknown) => unknown;
    getSnapshot: () => CatalogPlugin[];
    removeHost: (serverId: string) => void;
  };
  useStore: (ctx: unknown, a: unknown, b: unknown) => ExpoStore;
  store: { navigationRef?: { isReady?: () => boolean; current: unknown } };
  NavigationContainer: unknown;
  ctx: unknown;
  SidebarNavRows: unknown;
  PluginSurfaceScreen: unknown;
  QueryClientProvider: unknown;
  queryClient: unknown;
  Route: unknown;
  useNavigationBuilder: (router: unknown, options: { children: unknown[]; id: string }) => BuiltNav;
  StackRouter: unknown;
  slotName: string;
  Screen: unknown;
  StoreContext: unknown;
  SafeAreaProvider: unknown;
  ToastApiProvider: unknown;
  useIsCompactFormFactor: () => boolean;
  getHostRuntimeStore: () => { controllers: Map<string, HostController> };
  push: (href: string) => unknown;
  routingQueue: { queue: unknown[] };
  redirect: (serverId: string, pluginId: string, surfaceId: string) => string;
  paint: (width: number, height: number) => void;
};

type HostRuntime = {
  run: (id: string, bundle: string, runtime: object, publish: () => void) => HostPlugin;
  react: HostReact;
  createRoot: (container: DomNode) => { render: (node: unknown) => void; unmount: () => void };
  window: DomWindow;
  group: (plugins: unknown[], section: string) => SidebarGroup[];
  nav: (input: { section: string; pluginGroups: SidebarGroup[]; preferences: unknown[] }) => NavItem[];
  route: (serverId: string, pluginId: string, identity: { kind: string; id: string }) => string;
  currentScreen: (plugin: unknown, pathname: string, params: object) => { screenId: string; params: object } | null;
  target: (group: SidebarGroup, hostId: string | null) => { plugin: { serverId: string } };
  rememberHost: (key: string, hostId: string) => void;
  pageErrors: string[];
  shell: Shell;
  clientBundle: string;
};

function installedBundle(): string {
  // Release verification already supplies this exact official runtime to the compiler.
  // Use its real web bundle too, so upgrading the personal app does not replace the frozen fixture.
  const runtime = process.env.PASEO_SERVER_DIR?.trim();
  if (runtime) {
    const root = resolve(runtime);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; version?: string };
    assert.equal(manifest.name, "@getpaseo/server");
    assert.equal(manifest.version, HOST_VERSION, "the official host fixture stays pinned");
    return publicBundle(join(root, "dist", "server", "web-ui", "_expo", "static", "js", "web"), root);
  }
  // The publication gate's PATH has no paseo. Locate the public app directly.
  assert.equal(PUBLIC_APP, "/Applications/Paseo.app");
  const bin = join(PUBLIC_APP, "Contents", "Resources", "bin", "paseo");
  const version = execFileSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  assert.equal(version, HOST_VERSION);
  const web = join(PUBLIC_APP, "Contents", "Resources", "app-dist", "_expo", "static", "js", "web");
  return publicBundle(web, PUBLIC_APP);
}

function publicBundle(web: string, root: string): string {
  const files = readdirSync(web).filter((name) => /^index-.+\.js$/.test(name));
  assert.equal(files.length, 1, "one public web bundle");
  const bundle = join(web, files[0]!);
  assert.ok(bundle.startsWith(`${root}/`), "public host bundle");
  return bundle;
}

function moduleTrailer(source: string, marker: string): { id: number; deps: number[] } {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `installed host is missing ${marker}`);
  const next = source.indexOf("\n__d(function", at);
  assert.ok(next > at, `installed host has no module end after ${marker}`);
  const trailer = source.slice(Math.max(0, next - 8000), next);
  const match = /},(\d+),\[([0-9,]*)\]\);$/.exec(trailer);
  assert.ok(match, `installed host has no module id after ${marker}`);
  return { id: Number(match[1]), deps: match[2] ? match[2].split(",").map(Number) : [] };
}

function exportFrom<T>(loaded: Record<string, unknown>, name: string): T {
  assert.ok(name in loaded, name);
  return loaded[name] as T;
}

function bootHost(): Omit<HostRuntime, "clientBundle"> {
  const bundlePath = installedBundle();
  const raw = readFileSync(bundlePath, "utf8");
  const source = raw.replace(/\n__r\(\d+\);\n__r\(\d+\);\n__r\(0\);\s*$/, "\n");
  assert.equal(/\n__r\(\d+\);\s*$/.test(source), false, "host bootstrap calls stay unloaded");

  const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (html: string, options: { pretendToBeVisual: boolean; url: string }) => { window: DomWindow };
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: START_URL });
  const view = dom.window;
  const target = globalThis as unknown as Record<string, unknown>;
  const publish = (key: string, value: unknown) => {
    const existing = Object.getOwnPropertyDescriptor(target, key);
    if (existing && existing.configurable === false && existing.writable !== true && !existing.set) return;
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
  };
  publish("window", view);
  publish("document", view.document);
  for (const key of Object.getOwnPropertyNames(view)) {
    if (key === "window" || key === "document" || key === "navigator" || key === "screen" || key in target) continue;
    const description = Object.getOwnPropertyDescriptor(view, key);
    if (!description) continue;
    try { Object.defineProperty(target, key, description); } catch { /* already published */ }
  }
  // Unistyles records matchMedia("(min-width: Npx)") once, then updates from change events.
  // The listener has to exist before StyleSheet.configure, or every breakpoint stays false.
  let widthNow = 1280;
  const queries: Array<{ stub: MediaStub; listeners: Set<MediaListener> }> = [];
  const matchesQuery = (query: string, width: number) => {
    const min = /\(\s*min-width:\s*(\d+(?:\.\d+)?)px\s*\)/.exec(query);
    if (min) return width >= Number(min[1]);
    const max = /\(\s*max-width:\s*(\d+(?:\.\d+)?)px\s*\)/.exec(query);
    if (max) return width <= Number(max[1]);
    return false;
  };
  const media = (query: string): MediaStub => {
    const listeners = new Set<MediaListener>();
    const stub: MediaStub = {
      matches: matchesQuery(query, widthNow),
      media: query,
      onchange: null,
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      addEventListener(_type, listener) { listeners.add(listener); },
      removeEventListener(_type, listener) { listeners.delete(listener); },
      dispatchEvent: () => true,
    };
    queries.push({ stub, listeners });
    return stub;
  };
  view.matchMedia = media;
  target.matchMedia = media;
  const paint = (width: number, height: number) => {
    widthNow = width;
    view.innerWidth = width;
    view.innerHeight = height;
    view.devicePixelRatio = 2;
    const screen = view.screen;
    screen.orientation = {
      type: width >= height ? "landscape-primary" : "portrait-primary",
      angle: 0,
      addEventListener() {},
      removeEventListener() {},
    };
    publish("screen", screen);
    publish("innerWidth", width);
    publish("innerHeight", height);
    publish("devicePixelRatio", 2);
    for (const query of queries) {
      const next = matchesQuery(query.stub.media, width);
      if (next === query.stub.matches) continue;
      query.stub.matches = next;
      const event = { matches: next, media: query.stub.media };
      for (const listener of query.listeners) listener(event);
    }
    view.dispatchEvent(new view.Event("resize"));
  };
  paint(1280, 800);
  const frame = (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const cancel = (id: number) => clearTimeout(id);
  view.requestAnimationFrame = frame;
  view.cancelAnimationFrame = cancel;
  target.requestAnimationFrame = frame;
  target.cancelAnimationFrame = cancel;
  const offline = () => Promise.reject(new Error("isolated"));
  view.fetch = offline;
  target.fetch = offline;
  const pageErrors: string[] = [];
  trackHostTimers();
  view.addEventListener("error", (event: PageError) => {
    pageErrors.push(event.error?.message ?? event.message ?? "");
    event.preventDefault?.();
  });

  (0, eval)(source);
  const require = (globalThis as { __r?: (id: number) => Record<string, unknown> }).__r;
  assert.equal(typeof require, "function");
  const theme = moduleTrailer(source, "StyleSheet.configure({themes:");
  require!(theme.id);
  const load = (marker: string) => require!(moduleTrailer(source, marker).id);
  const runModule = load("_e.runPluginClientBundle=function") as { runPluginClientBundle: HostRuntime["run"] };
  const reactModule = moduleTrailer(source, ".createRoot=function");
  const reactDomId = new RegExp(`m\\.exports=r\\(d\\[0\\]\\)\\},(\\d+),\\[${reactModule.id}\\]\\);`).exec(source);
  assert.ok(reactDomId, "installed host react-dom client");
  let react: HostReact | undefined;
  const reactAttempts: string[] = [];
  for (const id of reactModule.deps) {
    try {
      const loaded = require!(id) as Partial<HostReact> & { useState?: unknown; default?: Partial<HostReact> & { useState?: unknown } };
      const candidate = typeof loaded.createElement === "function" ? loaded : loaded.default;
      if (candidate && typeof candidate.createElement === "function" && typeof candidate.useState === "function" && typeof candidate.useEffect === "function") {
        react = candidate as HostReact;
        break;
      }
      reactAttempts.push(String(id));
    } catch (error) {
      reactAttempts.push(`${id}:${error instanceof Error ? error.name : "throw"}`);
    }
  }
  assert.ok(react, `installed host react (${reactAttempts.join(" ")})`);
  assert.equal(typeof react.Component, "function");
  assert.equal(react.version, "19.1.0");
  const domClient = require!(Number(reactDomId[1])) as { createRoot?: HostRuntime["createRoot"] };
  assert.equal(typeof domClient.createRoot, "function");
  const grouped = load("e.groupPluginSidebarItems=function") as { groupPluginSidebarItems: HostRuntime["group"] };
  const remembered = load("e.rememberPluginContributionHost=function");
  const navigation = load("e.resolveSidebarNavItems=function") as { resolveSidebarNavItems: HostRuntime["nav"] };
  const routes = load("e.buildPluginSurfaceRoute=") as { buildPluginSurfaceRoute: HostRuntime["route"] };
  const screens = load("e.currentPluginScreen=function") as { currentPluginScreen: HostRuntime["currentScreen"] };
  const registryMod = load('Object.defineProperty(e,"pluginRegistry"');
  const navigationMod = load('Object.defineProperty(e,"createStaticNavigation"');
  const containerMod = load("e.NavigationContainer=");
  const storeMod = load("e.useStore=function") as { useStore: Shell["useStore"]; store: Shell["store"] };
  const ctxMod = load('Object.defineProperty(e,"ctx"');
  const rowsMod = load("e.SidebarNavRows=function");
  const surfaceMod = load("e.PluginSurfaceScreen=function");
  const queryMod = load('Object.defineProperty(e,"QueryClientProvider"');
  const queryClientMod = load('Object.defineProperty(e,"queryClient"');
  const routeMod = load("e.LocalRouteParamsContext=");
  const slotMod = load("e.INTERNAL_SLOT_NAME=");
  const screenMod = load("e.Group=e.Screen=void 0");
  const storeContextMod = load("e.StoreContext=");
  const safeMod = load('const e=["children","initialMetrics","initialSafeAreaInsets","style"]');
  const toastMod = load("e.useToast=function");
  const compactMod = load("e.useIsCompactFormFactor=");
  const hostStoreMod = load("e.getHostRuntimeStore=");
  const queueMod = load("e.routingQueue=") as { push: Shell["push"]; routingQueue: Shell["routingQueue"] };
  const legacyMod = load("e.buildLegacyPluginSurfaceRedirectRoute=");
  const shell: Shell = {
    registry: exportFrom(registryMod, "pluginRegistry"),
    useStore: storeMod.useStore,
    store: storeMod.store,
    NavigationContainer: exportFrom(containerMod, "NavigationContainer"),
    ctx: exportFrom(ctxMod, "ctx"),
    SidebarNavRows: exportFrom(rowsMod, "SidebarNavRows"),
    PluginSurfaceScreen: exportFrom(surfaceMod, "PluginSurfaceScreen"),
    QueryClientProvider: exportFrom(queryMod, "QueryClientProvider"),
    queryClient: exportFrom(queryClientMod, "queryClient"),
    Route: exportFrom(routeMod, "Route"),
    useNavigationBuilder: exportFrom(navigationMod, "useNavigationBuilder"),
    StackRouter: exportFrom(navigationMod, "StackRouter"),
    slotName: exportFrom<string>(slotMod, "INTERNAL_SLOT_NAME"),
    Screen: exportFrom(screenMod, "Screen"),
    StoreContext: exportFrom(storeContextMod, "StoreContext"),
    SafeAreaProvider: exportFrom(safeMod, "SafeAreaProvider"),
    ToastApiProvider: exportFrom(toastMod, "ToastApiProvider"),
    useIsCompactFormFactor: exportFrom(compactMod, "useIsCompactFormFactor"),
    getHostRuntimeStore: exportFrom(hostStoreMod, "getHostRuntimeStore"),
    push: queueMod.push,
    routingQueue: queueMod.routingQueue,
    redirect: exportFrom(legacyMod, "buildLegacyPluginSurfaceRedirectRoute"),
    paint,
  };
  assert.equal(typeof shell.useNavigationBuilder, "function");
  assert.equal(typeof shell.StackRouter, "function");
  assert.equal(typeof shell.push, "function");
  assert.equal(typeof shell.redirect, "function");
  assert.equal(typeof shell.registry.installCatalog, "function");
  assert.equal(typeof shell.registry.removeHost, "function");
  return {
    run: runModule.runPluginClientBundle, react, createRoot: domClient.createRoot!, window: view,
    group: grouped.groupPluginSidebarItems, nav: navigation.resolveSidebarNavItems,
    route: routes.buildPluginSurfaceRoute, currentScreen: screens.currentPluginScreen, pageErrors, shell,
    target: exportFrom(grouped, "selectPluginSidebarTarget"),
    rememberHost: exportFrom(remembered, "rememberPluginContributionHost"),
  };
}

async function hostClientBundle(): Promise<string> {
  const esbuild = createRequire(import.meta.url)("esbuild") as {
    build: (options: Record<string, unknown>) => Promise<{ outputFiles: Array<{ text: string }> }>;
  };
  const built = await esbuild.build({
    stdin: {
      contents: 'export { default } from "./index.client.tsx";',
      resolveDir: PLUGIN_ROOT,
      loader: "tsx",
      sourcefile: "host-client.tsx",
    },
    bundle: true,
    format: "cjs",
    platform: "browser",
    write: false,
    jsx: "automatic",
    legalComments: "none",
    external: [
      "react", "react/jsx-runtime", "react-native", "@getpaseo/plugin", "@getpaseo/plugin/client",
      "@getpaseo/plugin/client/react-native", "@getpaseo/plugin/client/ui", "@tanstack/react-query", "zod",
    ],
    define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" },
    logLevel: "silent",
  });
  const bundled = built.outputFiles[0]?.text ?? "";
  const clientBundle = `(function(require){var exports={};var module={exports:exports};\n${bundled}\nreturn module.exports;})`;
  assert.ok(!clientBundle.includes("/Users/"), "client bundle has no home path");
  assert.ok(clientBundle.length > 0, "client bundle");
  return clientBundle;
}

function settingsRead() {
  const language = getLanguage();
  return settingsReadSchema.parse({
    language,
    revision: "rev-1",
    needsSetup: true,
    problem: null,
    envOverride: false,
    candidatesNote: null,
    candidates: [],
    leaders: [],
    fallbackLeader: null,
    document: {
      language,
      projects: {},
      concurrency: { global: 5, pools: {}, roles: {} },
      staleStopPct: {},
      thresholds: Object.fromEntries(THRESHOLD_KEYS.map((key) => [key, 10])),
      families: {},
      bannedProviders: { providers: [], families: [], pools: [], models: [] },
      disabledPools: [],
    },
  });
}

function clientSource(body: string): string {
  return `(function(){return {default:function(client){${body}\nreturn function(){};}}})`;
}

function tabLabels(): string[] {
  return [
    t("application.board"),
    ...PANEL_TAB_IDS.map((id) => panelTabLabel(id)),
    t("settings.screen.title"),
  ];
}

function clientError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\/Users\/\S+/g, "<home>").slice(0, 240);
}

let host: HostRuntime;
const hostTimeouts: Array<ReturnType<typeof setTimeout>> = [];
const hostIntervals: Array<ReturnType<typeof setInterval>> = [];
const hostImmediates: Array<ReturnType<typeof setImmediate>> = [];

function trackHostTimers(): void {
  const nativeTimeout = globalThis.setTimeout as (handler: (...handlerArgs: unknown[]) => void, timeout?: number, ...args: unknown[]) => ReturnType<typeof setTimeout>;
  const nativeInterval = globalThis.setInterval as (handler: (...handlerArgs: unknown[]) => void, timeout?: number, ...args: unknown[]) => ReturnType<typeof setInterval>;
  const nativeImmediate = globalThis.setImmediate as (handler: (...handlerArgs: unknown[]) => void, ...args: unknown[]) => ReturnType<typeof setImmediate>;
  globalThis.setTimeout = ((handler: (...handlerArgs: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    const id = nativeTimeout(handler, timeout, ...args);
    hostTimeouts.push(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.setInterval = ((handler: (...handlerArgs: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    const id = nativeInterval(handler, timeout, ...args);
    hostIntervals.push(id);
    return id;
  }) as unknown as typeof setInterval;
  globalThis.setImmediate = ((handler: (...handlerArgs: unknown[]) => void, ...args: unknown[]) => {
    const id = nativeImmediate(handler, ...args);
    hostImmediates.push(id);
    return id;
  }) as unknown as typeof setImmediate;
}

function stopHost(): void {
  host?.window.close();
  for (const id of hostTimeouts) clearTimeout(id);
  for (const id of hostIntervals) clearInterval(id);
  for (const id of hostImmediates) clearImmediate(id);
  hostTimeouts.length = 0;
  hostIntervals.length = 0;
  hostImmediates.length = 0;
}

after(() => {
  stopHost();
});

before(async () => {
  (globalThis as { __kanbanContribute?: typeof contribute }).__kanbanContribute = contribute;
  const booted = bootHost();
  host = { ...booted, clientBundle: await hostClientBundle() };
}, { timeout: 60_000 });

describe("installed host sidebar entry", () => {
  it("registers one sidebar-kit item, command and the board surface on the public host", async () => {
    const registered = host.run(PLUGIN_ID, "(function(){return {default: globalThis.__kanbanContribute}})", {}, () => {});
    try {
      assert.deepEqual(registered.legacySidebarItems, []);
      assert.deepEqual(registered.sidebarItems.header.map(item => [item.id, item.title, typeof item.Component]), [[SCREEN_ID, "Paseo Kanban", "function"]]);
      assert.deepEqual(registered.commandCenterItems.map(item => [item.id, item.context]), [["open-board", "global"]]);
      assert.equal(registered.commandCenterItems[0]!.title, t("client.commandCenter.openBoard"));
      assert.deepEqual(registered.sidebarItems.footer, []);
      assert.deepEqual(registered.surfaces.map((screen) => [screen.id, screen.title]), [[SCREEN_ID, "Paseo Kanban"]]);
      assert.equal(registered.settingsScreens.length, 1);
      assert.equal(registered.settingsScreens[0]!.id, "config");
      assert.equal(registered.settingsScreens[0]!.icon, "Settings");
      assert.ok(registered.settingsScreens[0]!.title.length > 0);
      assert.equal(registered.workspacePanels.length, 1);
      assert.equal(registered.workspacePanels[0]!.id, SCREEN_ID);
      assert.equal(registered.workspacePanels[0]!.icon, "SquareKanban");
      assert.equal(registered.workspacePanels[0]!.context, "workspace");
      assert.ok(registered.workspacePanels[0]!.title.length > 0);
      const plugin = { ...registered, serverId: "local", id: PLUGIN_ID };
      const groups = host.group([plugin], "header");
      assert.equal(groups.length, 1);
      assert.equal(groups[0]!.kind, "item");
      assert.equal(groups[0]!.pluginId, PLUGIN_ID);
      assert.equal(groups[0]!.contributionId, SCREEN_ID);
      assert.equal(groups[0]!.title, "Paseo Kanban");

      const items = host.nav({ section: "header", pluginGroups: groups, preferences: [] });
      assert.deepEqual(items.filter((item) => item.kind === "plugin").map((item) => ({
        kind: item.kind, key: item.key, visible: item.visible,
      })), [{ kind: "plugin", key: "plugin:paseo-kanban:board", visible: true }]);
      const hidden = host.nav({ section: "header", pluginGroups: groups, preferences: [{ key: "plugin:paseo-kanban:board", visible: false }] });
      assert.equal(hidden.find(item => item.key === "plugin:paseo-kanban:board")?.visible, false);
      assert.deepEqual(items.filter((item) => item.kind === "builtin").map((item) => item.key), [
        "new-workspace", "history", "search", "schedules",
      ]);
      assert.equal(host.route("local", PLUGIN_ID, { kind: "sidebar", id: SCREEN_ID }), "/h/local/plugin/paseo-kanban/sidebar/board");
      assert.deepEqual(host.currentScreen(plugin, "/h/local/plugin/paseo-kanban/sidebar/board", {}), { screenId: SCREEN_ID, params: {} });
      assert.deepEqual(host.currentScreen(plugin, "/h/local/plugin/paseo-kanban/surface/board", {}), { screenId: SCREEN_ID, params: {} });
    } finally {
      await registered.cleanup();
    }
  });

  it("opens the same board from the desktop row, the compact row, and the old surface link", { timeout: 60_000 }, async () => {
    const shell = host.shell;
    const redirect = shell.redirect("local", PLUGIN_ID, SCREEN_ID);
    assert.equal(redirect, "/h/local/plugin/paseo-kanban/sidebar/board");
    const localClient = { serverId: "local" };
    const localSnapshot = { client: localClient, connectionStatus: "online", serverId: "local" };
    const store = shell.getHostRuntimeStore();
    store.controllers.set("local", { getSnapshot: () => localSnapshot, getClient: () => localClient });
    await Promise.resolve(shell.registry.installCatalog("local", [{
      id: PLUGIN_ID,
      clientBundle: host.clientBundle,
      requirements: { paseo: ">=0.11.0 <0.12.0" },
    }], {
      client: {
        invokePluginRpc(...args: unknown[]) {
          const name = args.find((value) => typeof value === "string" && value.includes("."));
          if (name === "kanban.config.read") return Promise.resolve(settingsRead());
          return Promise.resolve(null);
        },
      },
      audio: { play() {}, stop() {} },
    }));
    const catalog = () => shell.registry.getSnapshot().find((row) => row.id === PLUGIN_ID);
    const registered = catalog();
    assert.ok(registered, "catalog registration");
    assert.equal(registered.legacySidebarItems?.length, 0);
    assert.equal(registered.sidebarItems?.header.length, 1);
    assert.equal(registered.workspacePanels?.[0]?.id, SCREEN_ID);
    assert.equal(registered.workspacePanels?.[0]?.context, "workspace");

    const started: string[] = [];
    const react = host.react;
    class Boundary extends react.Component {
      state = { error: "" };
      static getDerivedStateFromError(error: unknown) {
        return { error: clientError(error) };
      }
      render() {
        return this.state.error
          ? react.createElement("pre", { "data-boundary": "error" }, this.state.error)
          : this.props.children;
      }
    }
    function surfaceParams(): { serverId: string; pluginId: string; contributionKind: string; contributionId: string } | null {
      const query = new URLSearchParams(host.window.location.search);
      const fromQuery = {
        serverId: query.get("serverId") ?? "",
        pluginId: query.get("pluginId") ?? "",
        contributionKind: query.get("contributionKind") ?? "",
        contributionId: query.get("contributionId") ?? "",
      };
      if (fromQuery.pluginId && fromQuery.contributionId) return fromQuery;
      const match = /^\/h\/([^/]+)\/plugin\/([^/]+)\/(sidebar|surface)\/([^/]+)\/?$/.exec(host.window.location.pathname);
      if (!match) return null;
      return { serverId: match[1]!, pluginId: match[2]!, contributionKind: match[3]!, contributionId: match[4]! };
    }
    function ProbeRoot() {
      const compact = shell.useIsCompactFormFactor();
      const [, setTick] = react.useState(0);
      react.useEffect(() => {
        const history = host.window.history;
        const pushState = history.pushState.bind(history);
        const replaceState = history.replaceState.bind(history);
        const wrap = (original: (...args: unknown[]) => void) => (...args: unknown[]) => {
          const before = `${host.window.location.pathname}${host.window.location.search}`;
          original(...args);
          const after = `${host.window.location.pathname}${host.window.location.search}`;
          if (after !== before) queueMicrotask(() => setTick((value) => value + 1));
        };
        history.pushState = wrap(pushState);
        history.replaceState = wrap(replaceState);
        return () => {
          history.pushState = pushState;
          history.replaceState = replaceState;
        };
      }, []);
      const params = surfaceParams();
      // MobileSidebar passes onBeforeNavigate. DesktopSidebar renders the same rows without it.
      const rows = react.createElement(shell.SidebarNavRows, compact
        ? { onBeforeNavigate: () => { started.push("before"); } }
        : {});
      let surface: unknown = null;
      if (params?.pluginId === PLUGIN_ID && params.contributionId === SCREEN_ID) {
        const screen = react.createElement(Boundary, null, react.createElement(shell.PluginSurfaceScreen, null));
        surface = react.createElement("div", { "data-surface": params.contributionKind }, react.createElement(shell.Route, {
          route: { params },
          node: {
            contextKey: "./h/[serverId]/plugin/[pluginId]/[contributionKind]/[contributionId].tsx",
            route: SCREEN_ID,
          },
        }, screen));
      }
      return react.createElement("div", { "data-compact": compact ? "true" : "false" }, rows, surface);
    }
    function Slot() {
      const screens = [react.createElement(shell.Screen, { key: "root", name: shell.slotName, component: ProbeRoot })];
      const built = shell.useNavigationBuilder(shell.StackRouter, { children: screens, id: shell.slotName });
      const route = built.state.routes[built.state.index];
      assert.ok(route, "navigation route");
      return react.createElement(built.NavigationContent, null, built.descriptors[route.key]?.render());
    }
    function Harness() {
      const expo = shell.useStore(shell.ctx, {}, undefined);
      const tree = react.createElement(shell.NavigationContainer, {
        ref: expo.navigationRef,
        initialState: expo.state,
        linking: expo.linking,
        documentTitle: { enabled: false },
        onReady: expo.onReady,
      }, react.createElement(Slot, null));
      const withStore = react.createElement(shell.StoreContext, { value: expo }, tree);
      const withSafe = react.createElement(shell.SafeAreaProvider, {
        initialMetrics: { frame: { x: 0, y: 0, width: 1280, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
      }, withStore);
      const withToast = react.createElement(shell.ToastApiProvider, { api: { showToast() {} } }, withSafe);
      return react.createElement(shell.QueryClientProvider, { client: shell.queryClient }, withToast);
    }

    const container = host.window.document.createElement("div");
    host.window.document.body.appendChild(container);
    const root = host.createRoot(container);
    host.pageErrors.length = 0;
    root.render(react.createElement(Harness, null));
    const labels = () => [...container.querySelectorAll('[role="button"]')].flatMap((node) => {
      const label = node.getAttribute("aria-label");
      return label ? [label] : [];
    });
    const fail = (step: string): never => {
      const boundary = container.querySelector("[data-boundary]")?.textContent ?? "";
      assert.fail(`${step}; path=${host.window.location.pathname}; queue=${shell.routingQueue.queue.length}; errors=${host.pageErrors.map(clientError).join(";")}; boundary=${clientError(boundary)}`);
    };
    const waitFor = async (step: string, ready: () => boolean) => {
      const startedAt = Date.now();
      while (!ready()) {
        if (Date.now() - startedAt > 4_000) fail(step);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const compact = () => container.querySelector("[data-compact]")?.getAttribute("data-compact");
    const surface = () => container.querySelector("[data-surface]")?.getAttribute("data-surface");
    const panelReady = (kind: string) => surface() === kind
      && shell.routingQueue.queue.length === 0
      && host.pageErrors.length === 0
      && !container.querySelector("[data-boundary]")
      && tabLabels().every((label) => labels().includes(label));
    const showLanguage = async (step: string) => {
      const button = [...container.querySelectorAll('[role="button"]')].find((node) => node.getAttribute("aria-label") === t("settings.screen.title"));
      assert.ok(button, step);
      button.click();
      const title = t("settings.language.title");
      const expected = [
        t("settings.language.option.en"),
        t("settings.language.option.zh-CN"),
        t("settings.language.option.system"),
      ].map((option) => `${title}${t("common.colon")}${option}`);
      await waitFor(`${step} language`, () => {
        const radios = [...container.querySelectorAll('[role="radio"]')].flatMap((node) => {
          const label = node.getAttribute("aria-label");
          return label ? [label] : [];
        });
        const groups = [...container.querySelectorAll('[role="radiogroup"]')].flatMap((node) => {
          const label = node.getAttribute("aria-label");
          return label ? [label] : [];
        });
        return expected.every((label) => radios.includes(label)) && groups.includes(title);
      });
    };
    const leavePanel = async () => {
      host.window.history.replaceState(null, "", "/h/local");
      await waitFor("leave the board", () => surface() == null && host.window.location.pathname === "/h/local");
    };
    try {
      shell.paint(1280, 800);
      await waitFor("desktop row", () => compact() === "false"
        && container.querySelectorAll(`[data-testid="${SIDEBAR_TEST_ID}"]`).length === 1
        && shell.store.navigationRef?.isReady?.() === true);
      const desktop = container.querySelector(`[data-testid="${SIDEBAR_TEST_ID}"]`);
      assert.equal(desktop?.getAttribute("aria-label"), "Paseo Kanban");
      assert.equal(desktop?.getAttribute("role"), "button");
      desktop?.click();
      await waitFor("desktop entry did not open the board", () => panelReady("surface")
        && host.window.location.pathname === "/h/local/plugin/paseo-kanban/surface/board");
      assert.deepEqual(started, []);
      await showLanguage("desktop settings");

      await leavePanel();
      shell.paint(390, 844);
      await waitFor("compact entry", () => compact() === "true"
        && container.querySelectorAll(`[data-testid="${SIDEBAR_TEST_ID}"]`).length === 1);
      container.querySelector(`[data-testid="${SIDEBAR_TEST_ID}"]`)?.click();
      await waitFor("compact entry did not open the board", () => panelReady("surface")
        && host.window.location.pathname === "/h/local/plugin/paseo-kanban/surface/board");
      assert.deepEqual(started, ["before"]);
      await showLanguage("compact settings");

      await leavePanel();
      await Promise.resolve(shell.push("/h/local/plugin/paseo-kanban/surface/board"));
      await waitFor("surface deep link did not open the board", () => panelReady("surface")
        && host.window.location.pathname === "/h/local/plugin/paseo-kanban/surface/board");
      await showLanguage("surface settings");

      await leavePanel();
      await Promise.resolve(shell.push(redirect));
      await waitFor("legacy surface redirect did not open the board", () => panelReady("sidebar")
        && host.window.location.pathname === redirect);
      await showLanguage("redirect settings");
      assert.equal(catalog()?.workspacePanels?.[0]?.id, SCREEN_ID);
      assert.equal(catalog()?.workspacePanels?.[0]?.context, "workspace");
    } finally {
      root.unmount();
      container.remove();
      await Promise.resolve(shell.registry.removeHost("local"));
      store.controllers.delete("local");
      host.pageErrors.length = 0;
    }
    assert.equal(catalog(), undefined);
  });

  it("clears the registration and can register the same ids again", async () => {
    const first = host.run(PLUGIN_ID, "(function(){return {default: globalThis.__kanbanContribute}})", {}, () => {});
    await first.cleanup();
    assert.equal(first.legacySidebarItems.length, 0);
    assert.equal(first.sidebarItems.header.length, 0);
    assert.equal(first.surfaces.length, 0);
    assert.equal(first.workspacePanels.length, 0);
    assert.equal(first.settingsScreens.length, 0);
    assert.equal(first.commandCenterItems.length, 0);
    const second = host.run(PLUGIN_ID, "(function(){return {default: globalThis.__kanbanContribute}})", {}, () => {});
    try {
      assert.equal(second.legacySidebarItems.length, 0);
      assert.equal(second.sidebarItems.header.length, 1);
      assert.equal(second.commandCenterItems.length, 1);
      assert.equal(second.surfaces.length, 1);
    } finally {
      await second.cleanup();
    }
  });

  it("coalesces multiple hosts and uses the current or last selected screen host", async () => {
    const local = host.run(PLUGIN_ID, host.clientBundle, {}, () => {});
    const remote = host.run(PLUGIN_ID, host.clientBundle, {}, () => {});
    try {
      const groups = host.group([{ ...local, serverId: "local" }, { ...remote, serverId: "remote" }], "header");
      assert.equal(groups.length, 1);
      assert.equal(groups[0]!.kind, "item");
      host.rememberHost(`${PLUGIN_ID}/screens`, "local");
      assert.equal(host.target(groups[0]!, null).plugin.serverId, "local");
      assert.equal(host.target(groups[0]!, "remote").plugin.serverId, "remote");
      host.rememberHost(`${PLUGIN_ID}/screens`, "remote");
      assert.equal(host.target(groups[0]!, null).plugin.serverId, "remote");
      assert.equal(host.target(groups[0]!, "local").plugin.serverId, "local");
    } finally {
      await local.cleanup(); await remote.cleanup();
      host.rememberHost(`${PLUGIN_ID}/screens`, "local");
    }
  });

  it("keeps the installed host errors for a duplicate id, a missing surface and an unknown icon", async () => {
    await assert.rejects(
      async () => host.run("sample", clientSource(`
        client.addScreen({id:"board", title:"Board", Component:function(){return null;}});
        client.addSidebarHeaderItem({id:"board", title:"Board", Component:function(){return null;}});
        client.addSidebarItem({id:"board", title:"Board", icon:"SquareKanban", surface:"board"});
      `), {}, () => {}),
      /Duplicate sidebar header item: board/,
    );
    await assert.rejects(
      async () => host.run("sample", clientSource(`
        client.addSidebarItem({id:"board", title:"Board", icon:"SquareKanban", surface:"missing"});
      `), {}, () => {}),
      /Sidebar item board references missing surface missing/,
    );
    await assert.rejects(
      async () => host.run("sample", clientSource(`
        client.addScreen({id:"board", title:"Board", Component:function(){return null;}});
        client.addSidebarItem({id:"board", title:"Board", icon:"NotARealIcon", surface:"board"});
      `), {}, () => {}),
      /Unknown Lucide icon: NotARealIcon/,
    );
  });

  it("accepts the installed addSurface alias without using it for the board title", async () => {
    const registered = host.run("sample", clientSource(`
      client.addSurface("board", function Board(){return null;});
      client.addSidebarItem({id:"board", title:"Paseo Kanban", icon:"SquareKanban", surface:"board"});
    `), {}, () => {});
    try {
      assert.deepEqual(registered.surfaces.map((screen) => [screen.id, screen.title]), [["board", "board"]]);
      assert.equal(registered.legacySidebarItems.length, 1);
      assert.equal(registered.sidebarItems.header.length, 0);
    } finally {
      await registered.cleanup();
    }
  });
});
