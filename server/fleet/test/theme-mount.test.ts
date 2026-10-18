import { setLanguage as setHostLanguage } from "../../../shared/i18n";
// Mount production components on React Native Web; replace only the host transport.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
import { build } from "esbuild";
import type { PluginTheme } from "@getpaseo/plugin";
import { paletteFromTheme } from "../../../shared/fleet/palette";
import { PANEL_TABS } from "../../../shared/fleet/panel-tabs";
import { buildSupervisorRows } from "../../../shared/fleet/supervisor-shift";
import { LIGHT_THEME, DARK_THEME } from "./fixtures/themes";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

const at = "2026-06-01T12:00:00.000Z";
const companies = ["green", "yellow", "red"].map((tone, index) => ({
  id: `demo-${tone}`, name: `Demo ${tone}`, adapter: "manual", remainingPct: 90 - index * 40,
  headline: "Demo quota", stale: false, notice: null,
  windows: [{ id: tone, name: "Week", usedPct: 10 + index * 40, remainingPct: 90 - index * 40,
    resetsAt: null, source: "manual", readAt: at, sourceText: "Demo reading", who: "Demo executor", dispatchText: "Ready",
    pacePct: 50, stopPct: 90, showPace: true, tone, amountText: null }],
}));
const thresholds = { reminderTokens: 100, warningTokens: 200 };
const rows = buildSupervisorRows({ thresholds, slots: ["normal", "reminder", "warning"].map(project => ({ project, code: project, agentId: project })),
  agents: [100, 101, 201].map((contextTokens, index) => ({ id: ["normal", "reminder", "warning"][index], status: "idle", createdAt: null, contextTokens, handoverPath: null, handoverPreview: null, found: true })), todayUsd: {}, now: 0 });
const snapshot = {
  generatedAt: at, roles: [], agents: [], alerts: [{ level: "yellow", kind: "Demo warning", text: "Demo note", agentId: null }],
  decisions: [{ id: "demo-question", project: "demo", title: "Demo question", detail: "A: proceed; B: wait. Recommend: A", blocking: true, kind: "decide", source: "leader", createdAt: at, agentId: null }],
  supervisorDecisions: [], recentChoices: [], decisionMaint: { enabled: false }, schedules: [],
  kanban: { presence: "absent", available: false, counts: [], queueShown: false, waiting: [] },
  changes: [], cursorNotes: [], sweep: { enabled: false, entries: [] }, supervisors: [], warnings: [], daemonCrashesToday: 0,
  home: { companies, days: [{ label: "6/1", today: true, claude: 100, cursor: 200, grok: 300 }],
    roleShares: [{ name: "Executor", pct: 60, tokens: 600 }, { name: "Reviewer", pct: 40, tokens: 400 }], roleCards: [] },
  supervisorPanel: { rows, details: [], tasks: [], handoffs: [], thresholds }, pausedProjects: [],
};

test("homepage, all panel tabs and settings repaint from two complete host themes without remounting", async () => {
  setHostLanguage("en");
  assert.equal(new Set(Object.values(LIGHT_THEME.colors)).size, 11);
  assert.equal(new Set(Object.values(DARK_THEME.colors)).size, 11);
  for (const key of Object.keys(LIGHT_THEME.colors) as (keyof PluginTheme["colors"])[]) assert.notEqual(LIGHT_THEME.colors[key], DARK_THEME.colors[key]);
  const dir = await mkdtemp(join(tmpdir(), "theme-mount-"));
  const dom = new JSDOM("<html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, any>;
  for (const key of Object.getOwnPropertyNames(dom.window)) if (!(key in g)) try { g[key] = dom.window[key]; } catch {}
  g.window = dom.window; g.document = dom.window.document;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0); g.cancelAnimationFrame = clearTimeout;
  const usage = { generatedAt: at, scannedAt: at, scanning: false, pricesAt: null, plans: [], byModel: [], byRole: [], companies,
    totals: { apiUsd: 0, planUsd: 0, tokens: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100, calls: 1 } }, warnings: [] };
  let prefs = { fontStep: "md", colorMode: "dark", tab: "overview", language: "en" };
  g.__themeRpc = async (name: string, input: any) => {
    if (name === "board.panel-prefs") return prefs = { ...prefs, ...input };
    if (name === "board.snapshot") return snapshot;
    if (name === "board.insights") return { generatedAt: at, unreviewedMerges: [], sandboxAgents: { readable: false, bots: [] }, scorecard: [], models: [], modelsBaselineAt: null, warnings: [] };
    if (name === "board.usage") return usage;
    if (name === "board.access") return { checkedAt: at, checking: false, warning: null, services: [], roles: [] };
    if (name === "board.roles-page") return { generatedAt: at, cards: [{ key: "executor", label: "Demo executor", rows: [], orderLines: [], history: [] }], warnings: [] };
    if (name === "config.read") return { file: input.file, revision: "demo", language: "en", warnings: [], document: input.file === "plans"
      ? { plans: [{ id: "demo", name: "Demo pool", adapter: "manual", providers: [], dispatch: false }], dispatchPriority: null }
      : { language: "en", hiddenPlans: [], bannedProviders: [], adapters: {}, leaderUsage: thresholds },
      dispatchRows: [{ slot: "executor.demo", role: "executor", tier: "L1", profile: "Demo profile", defaults: [{ context: "", effort: "low", order: 1 }], supportedEfforts: ["low", "medium"], capabilityKnown: true }] };
    throw new Error(`Unexpected host operation: ${name}`);
  };
  let mounted: any;
  const tick = () => new Promise(resolve => setTimeout(resolve, 80));
  const normalize = (color: string) => { const node = dom.window.document.createElement("div"); node.style.color = color; return node.style.color; };
  const allowedColors = (theme: PluginTheme) => {
    const p = paletteFromTheme(theme);
    return new Set([...Object.values(theme.colors), ...Object.values(p).filter((value): value is string => typeof value === "string"), ...Object.values(p.poolColors), ...p.shareColors].map(normalize));
  };
  const sample = (theme: PluginTheme) => {
    const allowed = allowedColors(theme), colors: string[] = [];
    for (const element of mounted.container.querySelectorAll("*")) {
      let hidden = false;
      for (let parent = element; parent && parent !== mounted.container; parent = parent.parentElement) if (dom.window.getComputedStyle(parent).display === "none") { hidden = true; break; }
      if (hidden) continue;
      const style = dom.window.getComputedStyle(element);
      const add = (value: string, property: string) => {
        if (!value || value === "transparent" || /rgba\([^)]*,\s*0\)$/.test(value)) return;
        assert.ok(allowed.has(normalize(value)), `${property} ${value} on ${element.outerHTML.slice(0, 200)}`);
        colors.push(normalize(value));
      };
      if ([...element.childNodes].some((node: any) => node.nodeType === 3 && node.textContent.trim()) || element.matches("input,textarea")) add(style.color, "color");
      add(style.backgroundColor, "backgroundColor");
      for (const side of ["Top", "Right", "Bottom", "Left"]) if (parseFloat(style[`border${side}Width`]) > 0) add(style[`border${side}Color`], `border${side}Color`);
    }
    assert.ok(colors.length > 10, "The real surface must have painted content");
    assert.ok(colors.includes(normalize(theme.colors.foreground)));
    assert.ok(colors.includes(normalize(paletteFromTheme(theme).textSecondary)));
    return new Set(colors);
  };
  try {
    const outfile = join(dir, "entry.mjs");
    await build({ stdin: { contents: `
      import {createRoot} from 'react-dom/client'; import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
      import {View} from 'react-native'; import {RoleBoard} from './client/fleet/board'; import {Home} from './client/fleet/home'; import {FleetSettings} from './client/fleet/settings'; import {useStyles} from './client/fleet/ui';
      const layout={compact:false,platform:'web'};
      function Surface({kind,theme,data}){const s=useStyles(theme,layout);const props={theme,layout,host:{id:'demo-host',label:'Demo'},navigation:{openAgent(){}}};
        return kind==='home'?<View style={s.screen}><Home s={s} data={data} onNavigate={()=>{}}/></View>:kind==='settings'?<FleetSettings {...props}/>:<RoleBoard {...props}/>;}
      export function mount(kind,theme,data){const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
        const query=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
        const update=theme=>root.render(<QueryClientProvider client={query}><Surface kind={kind} theme={theme} data={data}/></QueryClientProvider>);
        update(theme);return {container,update,unmount:()=>{root.unmount();query.clear();container.remove();}};}
    `, resolveDir: resolve(import.meta.dirname, "../../.."), sourcefile: "entry.tsx", loader: "tsx" },
      bundle: true, platform: "node", format: "esm", outfile, jsx: "automatic", logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" }, alias: { "react-native": "react-native-web" },
      plugins: [{ name: "isolated-host", setup(builder) {
        builder.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: "rpc", namespace: "fake" }));
        builder.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export const useRpc=rpc=>input=>globalThis.__themeRpc(rpc.name,input);", loader: "js" }));
      } }], banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    });
    const { mount } = await import(pathToFileURL(outfile).href);
    for (const kind of ["home", "board", "settings"]) {
      mounted = mount(kind, LIGHT_THEME, snapshot); await tick(); await tick();
      const visit = async (theme: PluginTheme) => {
        if (kind !== "board") return sample(theme);
        const aggregate = new Set<string>();
        for (const [index, tab] of PANEL_TABS.entries()) {
          mounted.container.querySelectorAll('[role="tab"]')[index].click(); await tick(); await tick();
          assert.equal(mounted.container.querySelectorAll('[role="tab"]')[index].getAttribute("aria-selected"), "true", tab.id);
          const selected = mounted.container.querySelectorAll('[role="tab"]')[index];
          assert.equal(dom.window.getComputedStyle(selected).backgroundColor, normalize(theme.colors.accent));
          const label = [...selected.querySelectorAll("*")].find((element: any) => element.textContent === tab.label);
          assert.ok(label, "Selected tab label must render");
          assert.equal(dom.window.getComputedStyle(label).color, normalize(theme.colors.accentForeground));
          for (const color of sample(theme)) aggregate.add(color);
        }
        return aggregate;
      };
      const light = await visit(LIGHT_THEME);
      mounted.update(DARK_THEME); await tick();
      const dark = await visit(DARK_THEME);
      assert.notDeepEqual(dark, light, `${kind} must repaint when theme changes`);
      for (const color of dark) assert.ok(!light.has(color), `${kind}: stale light color ${color}`);
      mounted.update(LIGHT_THEME); await tick();
      assert.deepEqual(await visit(LIGHT_THEME), light, `${kind} must repaint on a second switch`);
      if (kind === "settings") assert.ok(mounted.container.querySelectorAll("input").length > 10, "Settings fields and dispatch editor must mount");
      if (kind === "board") {
        const p = paletteFromTheme(LIGHT_THEME);
        for (const key of ["bg", "card", "raised", "border", "text", "textSecondary", "primaryBg", "primaryFg", "success", "warning", "danger", "accentBg", "accent"] as const) assert.ok(light.has(normalize(p[key])), key);
        assert.ok(!mounted.container.textContent.includes("Follow Paseo"), "No independent color mode switch remains");
      }
      mounted.unmount(); mounted = null;
    }
  } finally {
    mounted?.unmount(); dom.window.close(); delete g.__themeRpc;
    await rm(dir, { recursive: true, force: true });
  }
});
