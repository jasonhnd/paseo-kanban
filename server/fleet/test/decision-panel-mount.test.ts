// Mount the real decision and leader surfaces; only the host RPC transport is replaced.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { tIn } from "../../../shared/fleet/i18n";
import { LIGHT_THEME } from "./fixtures/themes";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

const createdAt = "2026-06-01T00:00:00.000Z";
const decision = { id: "demo-item", project: "demo", title: "Demo question", detail: "A: keep; B: wait. Recommend: A", blocking: true, kind: "decide", source: "leader", createdAt, agentId: null };
const snapshot = (decisions = [decision], recentChoices: unknown[] = []) => ({ generatedAt: "2026-06-01T12:00:00.000Z", decisions, recentChoices, decisionMaint: { enabled: false }, pausedProjects: [], alerts: [], supervisorPanel: { rows: [], details: [], tasks: [], handoffs: [] } });

test("mounted close and undo settle counts and blocking styles before and after refresh in both languages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decision-mount-"));
  const dom = new JSDOM("<html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, any>;
  for (const key of Object.getOwnPropertyNames(dom.window)) if (!(key in g)) try { g[key] = (dom.window as any)[key]; } catch {}
  g.window = dom.window; g.document = dom.window.document;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0); g.cancelAnimationFrame = clearTimeout;
  const calls: string[] = [];
  let fails = false;
  g.__decisionRpc = (_name: string, input: any) => { calls.push(input.choice); return Promise.resolve({ ok: !fails, message: fails ? "Demo failure" : "Saved" }); };
  let mounted: any;
  const tick = () => new Promise(resolve => setTimeout(resolve, 70));
  try {
    const outfile = join(dir, "entry.mjs");
    await build({ stdin: { contents: `import {createRoot} from 'react-dom/client'; import {QueryClient, QueryClientProvider} from '@tanstack/react-query'; import {Decisions} from './client/fleet/decisions'; import {LeaderTab} from './client/fleet/home'; import {AttentionBlock} from './client/fleet/leader-attention'; import {LeaderDetails} from './client/fleet/leader-details'; import {useStyles} from './client/fleet/ui'; import {LIGHT_THEME} from './server/fleet/test/fixtures/themes'; import {setLanguage} from './shared/fleet/i18n';
      export function mount(lang,which,initial){setLanguage(lang);const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);const query=new QueryClient();
      function Surface({data}){const s=useStyles(LIGHT_THEME,{compact:false,platform:'web'});return which==='attention'?<AttentionBlock s={s} data={data} nowMs={Date.parse(data.generatedAt)}/>:which==='details'?<LeaderDetails s={s} project="demo" data={data}/>:which==='leader'?<LeaderTab s={s} data={data} openAgent={null}/>:<Decisions s={s} data={data} openAgent={null} showSettings={false}/>;}
      const update=data=>root.render(<QueryClientProvider client={query}><Surface data={data}/></QueryClientProvider>);update(initial);return {container,update,unmount:()=>{root.unmount();query.clear();container.remove();}};}`,
      resolveDir: resolve(import.meta.dirname, "../../.."), sourcefile: "entry.tsx", loader: "tsx" }, bundle: true, platform: "node", format: "esm", outfile, jsx: "automatic", logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" }, alias: { "react-native": "react-native-web" },
      plugins: [{ name: "isolated-host", setup(builder) {
        builder.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: "rpc", namespace: "fake" }));
        builder.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export const useRpc = rpc => input => globalThis.__decisionRpc(rpc.name,input);", loader: "js" }));
      } }], banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    });
    const { mount } = await import(pathToFileURL(outfile).href);
    const rgb = (color: string) => { const node = dom.window.document.createElement("div"); node.style.color = color; return node.style.color; };
    for (const lang of ["en", "zh-CN"] as const) for (const surface of ["decisions", "leader"]) {
      const text = () => mounted.container.textContent as string;
      const label = (key: Parameters<typeof tIn>[1]) => tIn(lang, key);
      const click = async (key: Parameters<typeof tIn>[1]) => { const button = [...mounted.container.querySelectorAll("[aria-label]")].find((node: any) => node.getAttribute("aria-label") === label(key)) as any; assert.ok(button, label(key)); button.click(); await tick(); };
      const border = () => [...mounted.container.querySelectorAll("div")].find((node: any) => dom.window.getComputedStyle(node).borderLeftWidth === "4px") as any;
      const assertOpen = () => { assert.ok(text().includes(tIn(lang, "decisions.card.summaryBlocking", { count: 1, blocking: 1 })), text()); assert.equal(dom.window.getComputedStyle(border()).borderLeftColor, rgb(LIGHT_THEME.colors.statusDanger)); };
      const assertClosed = () => { assert.ok(text().includes(tIn(lang, "decisions.card.summary", { count: 0 })), text()); assert.ok(text().includes(tIn(lang, "decisions.card.processed", { count: 1 }))); assert.ok(!text().includes(label("decisions.meta.blocking"))); assert.equal(dom.window.getComputedStyle(border()).borderLeftColor, rgb(LIGHT_THEME.colors.border)); assert.ok(mounted.container.querySelector(`[aria-label="${label("decisions.actions.dismissUndoLabel")}"]`)); };
      mounted = mount(lang, surface, snapshot()); await tick(); assertOpen();
      await click("decisions.actions.dismiss"); await click("decisions.actions.cancel"); assertOpen();
      fails = true; await click("decisions.actions.dismiss"); await click("decisions.actions.dismissYesLabel"); assertOpen(); assert.ok(text().includes("Demo failure"));
      fails = false; await click("decisions.actions.dismiss"); await click("decisions.actions.dismissYesLabel"); assertClosed();
      mounted.update(snapshot([])); await tick(); assertClosed();
      await click("decisions.actions.dismissUndoLabel"); assertOpen();
      mounted.update(snapshot()); await tick(); assertOpen();
      mounted.unmount(); mounted = null;
      if (surface === "leader") {
        mounted = mount(lang, surface, snapshot([])); await tick(); assert.ok(!text().includes(label("home.unregistered"))); mounted.unmount();
        mounted = mount(lang, surface, snapshot([], [{ ...decision, letter: "A", doneAt: createdAt }])); await tick(); assert.ok(text().includes(label("home.unregistered"))); assert.ok(text().includes(decision.title)); mounted.unmount(); mounted = null;
      }
    }
    // A registered project bypasses the unregistered Decisions list entirely.
    const registered = (decisions = [decision]) => {
      const data = snapshot(decisions);
      return { ...data, supervisorPanel: { ...data.supervisorPanel, rows: [{ project: "demo", code: "DEMO", agentId: "demo-leader" }] } };
    };
    for (const lang of ["en", "zh-CN"] as const) for (const surface of ["attention", "details"]) {
      const text = () => mounted.container.textContent as string;
      const label = (key: Parameters<typeof tIn>[1]) => tIn(lang, key);
      const clickLabel = async (name: string) => {
        const button = [...mounted.container.querySelectorAll("[aria-label]")].find((node: any) => node.getAttribute("aria-label") === name) as any;
        assert.ok(button, name); button.click(); await tick();
      };
      const blockingLabel = () => [...mounted.container.querySelectorAll("div,span")].find((node: any) => node.textContent.trim() === (surface === "attention" ? label("leader.ui.blockingWork") : `${label("leader.ui.blockingWork")} · ${decision.id}`)) as any;
      const detailRow = () => {
        const marker = `${label("leader.ui.handled")} · ${decision.id}`;
        let node = [...mounted.container.querySelectorAll("div,span")].find((candidate: any) => candidate.textContent.trim() === marker)?.parentElement;
        if (!node) node = blockingLabel()?.parentElement;
        while (node && ![...node.children].some((child: any) => child.textContent === decision.title)) node = node.parentElement;
        assert.ok(node, "Decision detail row"); return node;
      };
      const assertOpen = () => {
        const count = surface === "attention" ? tIn(lang, "leader.attention.headingCount", { count: 1 }) : tIn(lang, "leader.ui.itemCount", { count: 1 });
        assert.ok(text().includes(count), text());
        const blocked = blockingLabel(); assert.ok(blocked, text());
        assert.equal(dom.window.getComputedStyle(blocked).color, rgb(LIGHT_THEME.colors.statusDanger));
        if (surface === "details") assert.equal(dom.window.getComputedStyle(detailRow()).borderLeftWidth, "3px");
      };
      const assertClosed = () => {
        const count = surface === "attention" ? tIn(lang, "leader.attention.headingCount", { count: 0 }) : tIn(lang, "leader.ui.itemCount", { count: 0 });
        assert.ok(text().includes(count), text());
        assert.ok(!blockingLabel(), text());
        const handled = [...mounted.container.querySelectorAll("div,span")].find((node: any) => node.textContent.trim() === (surface === "attention" ? label("leader.ui.handled") : `${label("leader.ui.handled")} · ${decision.id}`));
        assert.ok(handled, text());
        assert.notEqual(dom.window.getComputedStyle(handled).color, rgb(LIGHT_THEME.colors.statusDanger));
        if (surface === "details") assert.equal(dom.window.getComputedStyle(detailRow()).borderLeftWidth, "0px");
      };
      mounted = mount(lang, surface, registered()); await tick(); assertOpen();
      if (surface === "attention") await clickLabel(`${label("leader.attention.decide")} DEMO`);
      await clickLabel(label("decisions.actions.dismiss")); await clickLabel(label("decisions.actions.dismissYesLabel")); assertClosed();
      mounted.update(registered([])); await tick(); assertClosed();
      if (surface === "attention") {
        await clickLabel(`${label("leader.ui.collapse")} DEMO`); assertClosed();
        const collapsed = mounted.container.querySelector(`[aria-label="${label("decisions.actions.dismissUndoLabel")}"]`);
        assert.equal(collapsed, null);
        // The collapsed action opens the undo control instead of inviting another choice.
        await clickLabel(`${label("leader.attention.undoClose")} DEMO`); assertClosed();
      }
      await clickLabel(label("decisions.actions.dismissUndoLabel")); assertOpen();
      mounted.update(registered()); await tick(); assertOpen();
      if (surface === "attention") {
        await clickLabel(`${label("leader.ui.collapse")} DEMO`);
        assert.ok(mounted.container.querySelector(`[aria-label="${label("leader.attention.decide")} DEMO"]`));
      }
      mounted.unmount(); mounted = null;
    }
    assert.equal(calls.filter(choice => choice === "restore").length, 8);
  } finally {
    mounted?.unmount(); dom.window.close(); delete g.__decisionRpc;
    await rm(dir, { recursive: true, force: true });
  }
});
