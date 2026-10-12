/// <reference types="node" />
// Registers the real client on the installed public Paseo host and mounts its standard sidebar row.
// Desktop and compact widths share that row. This does not exercise a physical phone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire, register } from "node:module";
import { before, describe, it } from "node:test";
import { dirname, join } from "node:path";

register(new URL("./rn-hooks.mjs", import.meta.url));
const { default: contribute } = await import("../index.client");

const HOST_VERSION = "0.11.2";
const PLUGIN_ID = "paseo-kanban";
const SCREEN_ID = "board";
const START_URL = "https://example.invalid/h/local/plugin/paseo-kanban/surface/other";
const SIDEBAR_TEST_ID = "plugin-sidebar-paseo-kanban-board";

type HostPlugin = {
  id: string;
  cleanup: () => Promise<void>;
  surfaces: Array<{ id: string; title: string }>;
  settingsScreens: Array<{ id: string; title: string; icon: string }>;
  sidebarItems: { header: unknown[]; footer: unknown[] };
  legacySidebarItems: Array<{ id: string; title: string; icon: string; surface: string }>;
  workspacePanels: Array<{ id: string; title: string; icon: string; context: string }>;
};

type HostReact = {
  createElement: (type: unknown, props: Record<string, unknown> | null) => unknown;
  act?: (callback: () => void | Promise<void>) => Promise<void>;
  version: string;
};

type DomNode = {
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomNode | null;
  remove(): void;
  click(): void;
};

type DomWindow = {
  document: {
    createElement(tag: string): DomNode;
    body: { appendChild(node: DomNode): void };
  };
  location: { href: string };
  navigator: object;
  matchMedia: (query: string) => MediaStub;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  screen: ScreenStub;
  requestAnimationFrame: (callback: (time: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
  addEventListener(type: string, listener: (event: PageError) => void): void;
  close(): void;
};

type MediaStub = {
  matches: boolean;
  media: string;
  addListener: () => void;
  removeListener: () => void;
  addEventListener: () => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
  onchange: null;
};

type ScreenStub = {
  width: number;
  height: number;
  orientation: { type: string; angle: number; addEventListener: () => void; removeEventListener: () => void };
};

type PageError = { message?: string; error?: { message?: string }; preventDefault?: () => void };

type SidebarGroup = { kind: string; pluginId: string; contributionId: string; title: string; icon: string };

type NavItem = { kind: string; key: string; visible: boolean };

type HostRuntime = {
  source: string;
  run: (id: string, bundle: string, runtime: object, publish: () => void) => HostPlugin;
  react: HostReact;
  createRoot: (container: DomNode) => { render: (node: unknown) => void; unmount: () => void };
  window: DomWindow;
  group: (plugins: unknown[], section: string) => SidebarGroup[];
  nav: (input: { section: string; pluginGroups: SidebarGroup[]; preferences: unknown[] }) => NavItem[];
  route: (serverId: string, pluginId: string, identity: { kind: string; id: string }) => string;
  currentScreen: (plugin: unknown, pathname: string, params: object) => { screenId: string; params: object } | null;
  LegacyPluginSidebarRow: (props: { group: SidebarGroup; onBeforeNavigate?: () => void }) => unknown;
  pageErrors: string[];
};

function installedBundle(): string {
  const linked = execFileSync("/usr/bin/which", ["paseo"], { encoding: "utf8" }).trim();
  const bin = realpathSync(linked);
  const version = execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  assert.equal(version, HOST_VERSION);
  let dir = dirname(bin);
  let app = "";
  for (let hop = 0; hop < 6; hop += 1) {
    if (dir.endsWith("/Paseo.app")) { app = dir; break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  assert.ok(app === "/Applications/Paseo.app", "public desktop app");
  const web = join(app, "Contents", "Resources", "app-dist", "_expo", "static", "js", "web");
  const files = readdirSync(web).filter((name) => /^index-.+\.js$/.test(name));
  assert.equal(files.length, 1, "one public web bundle");
  return join(web, files[0]!);
}

function moduleTrailer(source: string, marker: string): { id: number; deps: number[] } {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `installed host is missing ${marker}`);
  const next = source.indexOf("\n__d(function", at);
  assert.ok(next > at, `installed host has no module end after ${marker}`);
  const trailer = source.slice(Math.max(0, next - 240), next);
  const match = /},(\d+),\[([0-9,]*)\]\);$/.exec(trailer);
  assert.ok(match, `installed host has no module id after ${marker}`);
  return { id: Number(match[1]), deps: match[2] ? match[2].split(",").map(Number) : [] };
}

function bootHost(): HostRuntime {
  const bundlePath = installedBundle();
  const raw = readFileSync(bundlePath, "utf8");
  assert.equal(raw.includes("renderNothing"), false, "installed host has no renderNothing sidebar path");
  assert.equal(raw.split("SidebarNavRows").length - 1, 3, "desktop and compact lists share SidebarNavRows");
  const legacyAt = raw.indexOf("e.LegacyPluginSidebarRow=function");
  const legacyEnd = raw.indexOf("\n__d(function", legacyAt);
  const legacyBody = raw.slice(legacyAt, legacyEnd);
  assert.equal(legacyBody.includes('variant:"compact"'), true);
  assert.equal(legacyBody.includes("useIsCompactFormFactor"), false);
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
  const media = (query: string): MediaStub => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  });
  view.matchMedia = media;
  target.matchMedia = media;
  const paint = (width: number, height: number) => {
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
  };
  paint(1280, 800);
  const frame = (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const cancel = (id: number) => clearTimeout(id);
  view.requestAnimationFrame = frame;
  view.cancelAnimationFrame = cancel;
  target.requestAnimationFrame = frame;
  target.cancelAnimationFrame = cancel;
  const pageErrors: string[] = [];
  view.addEventListener("error", (event: PageError) => {
    pageErrors.push(event.error?.message ?? event.message ?? "");
    event.preventDefault?.();
  });

  (0, eval)(source);
  const require = (globalThis as { __r?: (id: number) => Record<string, unknown> }).__r;
  assert.equal(typeof require, "function");
  const theme = moduleTrailer(source, "StyleSheet.configure({themes:");
  require!(theme.id);
  const runModule = require!(moduleTrailer(source, "_e.runPluginClientBundle=function").id) as {
    runPluginClientBundle: HostRuntime["run"];
  };
  const reactModule = moduleTrailer(source, ".createRoot=function");
  const reactDomId = new RegExp(`m\\.exports=r\\(d\\[0\\]\\)\\},(\\d+),\\[${reactModule.id}\\]\\);`).exec(source);
  assert.ok(reactDomId, "installed host react-dom client");
  let react: HostReact | undefined;
  const reactAttempts: string[] = [];
  for (const id of reactModule.deps) {
    try {
      const loaded = require!(id) as Partial<HostReact> & { useState?: unknown; default?: Partial<HostReact> & { useState?: unknown } };
      const candidate = typeof loaded.createElement === "function" ? loaded : loaded.default;
      if (candidate && typeof candidate.createElement === "function" && typeof candidate.useState === "function") {
        react = candidate as HostReact;
        break;
      }
      reactAttempts.push(String(id));
    } catch (error) {
      reactAttempts.push(`${id}:${error instanceof Error ? error.name : "throw"}`);
    }
  }
  assert.ok(react, `installed host react (${reactAttempts.join(" ")})`);
  assert.equal(react.version, "19.1.0");
  const domClient = require!(Number(reactDomId[1])) as { createRoot?: HostRuntime["createRoot"] };
  assert.equal(typeof domClient.createRoot, "function");
  const legacy = require!(moduleTrailer(source, "e.LegacyPluginSidebarRow=function").id) as {
    LegacyPluginSidebarRow: HostRuntime["LegacyPluginSidebarRow"];
  };
  const grouped = require!(moduleTrailer(source, "e.groupPluginSidebarItems=function").id) as {
    groupPluginSidebarItems: HostRuntime["group"];
  };
  const navigation = require!(moduleTrailer(source, "e.resolveSidebarNavItems=function").id) as {
    resolveSidebarNavItems: HostRuntime["nav"];
  };
  const routes = require!(moduleTrailer(source, "e.buildPluginSurfaceRoute=").id) as {
    buildPluginSurfaceRoute: HostRuntime["route"];
  };
  const screens = require!(moduleTrailer(source, "e.currentPluginScreen=function").id) as {
    currentPluginScreen: HostRuntime["currentScreen"];
  };
  return {
    source, run: runModule.runPluginClientBundle, react, createRoot: domClient.createRoot!, window: view,
    group: grouped.groupPluginSidebarItems, nav: navigation.resolveSidebarNavItems,
    route: routes.buildPluginSurfaceRoute, currentScreen: screens.currentPluginScreen,
    LegacyPluginSidebarRow: legacy.LegacyPluginSidebarRow, pageErrors,
  };
}

function clientSource(body: string): string {
  return `(function(){return {default:function(client){${body}\nreturn function(){};}}})`;
}

let host: HostRuntime;

before(() => {
  (globalThis as { __kanbanContribute?: typeof contribute }).__kanbanContribute = contribute;
  host = bootHost();
});

describe("installed host sidebar entry", () => {
  it("registers one standard nav item and the board surface on the public host", async () => {
    const registered = host.run(PLUGIN_ID, "(function(){return {default: globalThis.__kanbanContribute}})", {}, () => {});
    try {
      assert.deepEqual(registered.legacySidebarItems, [{
        id: SCREEN_ID, title: "Paseo Kanban", icon: "SquareKanban", surface: SCREEN_ID,
      }]);
      assert.deepEqual(registered.sidebarItems.header, []);
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
      assert.equal(groups[0]!.kind, "legacy");
      assert.equal(groups[0]!.pluginId, PLUGIN_ID);
      assert.equal(groups[0]!.contributionId, SCREEN_ID);
      assert.equal(groups[0]!.title, "Paseo Kanban");
      assert.equal(groups[0]!.icon, "SquareKanban");
      const items = host.nav({ section: "header", pluginGroups: groups, preferences: [] });
      assert.deepEqual(items.filter((item) => item.kind === "plugin").map((item) => ({
        kind: item.kind, key: item.key, visible: item.visible,
      })), [{ kind: "plugin", key: "plugin:paseo-kanban:board", visible: true }]);
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

  it("mounts the same standard row at a desktop width and a compact width", async () => {
    const registered = host.run(PLUGIN_ID, "(function(){return {default: globalThis.__kanbanContribute}})", {}, () => {});
    try {
      const plugin = { ...registered, serverId: "local", id: PLUGIN_ID };
      const group = host.group([plugin], "header")[0];
      assert.ok(group);
      for (const [width, height] of [[1280, 800], [390, 844]] as const) {
        host.window.innerWidth = width;
        host.window.innerHeight = height;
        host.window.screen.orientation.type = width >= height ? "landscape-primary" : "portrait-primary";
        const container = host.window.document.createElement("div");
        host.window.document.body.appendChild(container);
        const root = host.createRoot(container);
        const started: string[] = [];
        const href = host.window.location.href;
        const draw = () => {
          root.render(host.react.createElement(host.LegacyPluginSidebarRow, {
            group, onBeforeNavigate: () => { started.push("before"); },
          }));
        };
        if (host.react.act) await host.react.act(draw);
        else draw();
        await new Promise((resolve) => setTimeout(resolve, 30));
        const row = container.querySelector(`[data-testid="${SIDEBAR_TEST_ID}"]`);
        assert.ok(row, `sidebar row at ${width}`);
        assert.equal(row.getAttribute("aria-label"), "Paseo Kanban");
        let thrown = "";
        try { row.click(); } catch (error) { thrown = error instanceof Error ? error.message : String(error); }
        assert.deepEqual(started, ["before"]);
        const reported = [thrown, ...host.pageErrors].filter((message) => message.length > 0);
        assert.ok(reported.every((message) => message.includes("isReady")) || reported.length === 0);
        assert.equal(host.window.location.href, href);
        if (host.react.act) await host.react.act(() => { root.unmount(); });
        else root.unmount();
        container.remove();
        host.pageErrors.length = 0;
      }
    } finally {
      await registered.cleanup();
    }
  });

  it("clears the registration and can register the same ids again", async () => {
    const first = host.run(PLUGIN_ID, "(function(){return {default: globalThis.__kanbanContribute}})", {}, () => {});
    await first.cleanup();
    assert.equal(first.legacySidebarItems.length, 0);
    assert.equal(first.sidebarItems.header.length, 0);
    assert.equal(first.surfaces.length, 0);
    assert.equal(first.workspacePanels.length, 0);
    assert.equal(first.settingsScreens.length, 0);
    const second = host.run(PLUGIN_ID, "(function(){return {default: globalThis.__kanbanContribute}})", {}, () => {});
    try {
      assert.equal(second.legacySidebarItems.length, 1);
      assert.equal(second.sidebarItems.header.length, 0);
      assert.equal(second.surfaces.length, 1);
    } finally {
      await second.cleanup();
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
