import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { initializeSettings, readSettings, writeSettings } from "../settings";
import { readLeaderThresholds } from "../adapters/config";
import { buildSupervisorRows } from "../../../shared/fleet/supervisor-shift";
import { setLanguage, t } from "../../../shared/fleet/i18n";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("mounted settings save thresholds with revisions and homepage renders the configured colors in both languages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "leader-ui-"));
  initializeSettings(dir, fileURLToPath(new URL("../../../examples/", import.meta.url)));
  const dom = new JSDOM("<html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, any>;
  for (const key of Object.getOwnPropertyNames(dom.window)) if (!(key in g)) try { g[key] = (dom.window as any)[key]; } catch {}
  g.window = dom.window; g.document = dom.window.document;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0); g.cancelAnimationFrame = clearTimeout;
  g.__leaderRead = (input: any) => readSettings(input.file, dir);
  g.__leaderWrite = (input: any) => writeSettings(input, dir);
  let rpcCalls = 0;
  g.__leaderRpc = () => { rpcCalls++; throw new Error("Unexpected host mutation"); };
  let mounted: any;
  const tick = () => new Promise(resolve => setTimeout(resolve, 80));
  const waitFor = async (condition: () => boolean, message = "Timed out waiting for settings fields to mount") => {
    const deadline = Date.now() + 10_000;
    while (!condition() && Date.now() < deadline) await tick();
    assert.ok(condition(), message);
  };
  try {
    const outfile = join(dir, "entry.mjs");
    await build({ stdin: { contents: `import {createRoot} from 'react-dom/client'; import {QueryClient, QueryClientProvider} from '@tanstack/react-query'; import {SettingsEditor} from './client/fleet/settings'; import {LeaderBlock} from './client/fleet/home-leaders'; import {useStyles} from './client/fleet/ui'; import {LIGHT_THEME} from './server/fleet/test/fixtures/themes'; import {setLanguage} from './shared/fleet/i18n';
      function Entry({data}){const s=useStyles(LIGHT_THEME,{compact:false,platform:'web'});return data?<LeaderBlock s={s} data={data} openAgent={null}/>:<SettingsEditor s={s} file="config" read={globalThis.__leaderRead} write={globalThis.__leaderWrite}/>;}
      export function mount(lang,data){setLanguage(lang);const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);const query=new QueryClient();root.render(<QueryClientProvider client={query}><Entry data={data}/></QueryClientProvider>);return {container,unmount:()=>{root.unmount();query.clear();container.remove();}};}`,
      resolveDir: resolve(import.meta.dirname, "../../.."), sourcefile: "entry.tsx", loader: "tsx" }, bundle: true, platform: "node", format: "esm", outfile, jsx: "automatic", logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" }, alias: { "react-native": "react-native-web" },
      plugins: [{ name: "fake-host", setup(builder) {
        builder.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: "rpc", namespace: "fake" }));
        builder.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export const useRpc = rpc => input => globalThis.__leaderRpc(rpc.name,input);", loader: "js" }));
      } }], banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    });
    const { mount } = await import(pathToFileURL(outfile).href);
    setLanguage("en"); mounted = mount("en");
    const field = (key: "reminderTokens" | "warningTokens") => mounted.container.querySelector(`[aria-label="${t(`settings.leaderUsage.${key}`)}"]`);
    await waitFor(() => Boolean(field("reminderTokens") && field("warningTokens")));
    assert.equal(field("reminderTokens").value, "500000"); assert.equal(field("warningTokens").value, "750000");
    const fill = async (key: "reminderTokens" | "warningTokens", value: string) => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field(key), value);
      field(key).dispatchEvent(new dom.window.Event("input", { bubbles: true })); await tick();
    };
    const save = async (acknowledgement: string) => {
      mounted.container.querySelector(`[aria-label="${t("settings.save")}"]`).click();
      // A fixed render tick does not establish that the asynchronous file replacement finished.
      await waitFor(() => [...mounted.container.querySelectorAll('[role="alert"]')].some((node: any) => node.textContent.includes(acknowledgement)), "Timed out waiting for settings save acknowledgement");
    };
    setLanguage("en");
    await fill("reminderTokens", "100"); await fill("warningTokens", "200"); await save(t("settings.saved"));
    assert.deepEqual(readLeaderThresholds(dir), { reminderTokens: 100, warningTokens: 200 });
    assert.ok(mounted.container.textContent.includes(t("settings.saved")));
    await fill("warningTokens", "50"); await save(t("settings.leaderUsage.invalidOrder"));
    assert.ok(mounted.container.querySelector('[role="alert"]'));
    assert.ok(mounted.container.textContent.includes(t("settings.leaderUsage.invalidOrder")));
    assert.deepEqual(readLeaderThresholds(dir), { reminderTokens: 100, warningTokens: 200 });
    const config = await readSettings("config", dir);
    await writeSettings({ file: "config", revision: config.revision, document: { ...config.document, language: "zh-CN" } }, dir);
    setLanguage("en");
    await fill("warningTokens", "250"); await save(t("settings.conflict"));
    assert.ok(mounted.container.textContent.includes(t("settings.conflict")));
    mounted.unmount();
    setLanguage("zh-CN"); mounted = mount("zh-CN");
    await waitFor(() => Boolean(field("reminderTokens") && field("warningTokens")));
    await fill("warningTokens", "50"); await save(t("settings.leaderUsage.invalidOrder"));
    assert.ok(mounted.container.querySelector('[role="alert"]').textContent.includes(t("settings.leaderUsage.invalidOrder")));
    assert.deepEqual(readLeaderThresholds(dir), { reminderTokens: 100, warningTokens: 200 });
    for (const lang of ["en", "zh-CN"] as const) {
      setLanguage(lang);
      const thresholds = readLeaderThresholds(dir);
      const rows = buildSupervisorRows({ thresholds, slots: ["normal", "reminder", "warning"].map(project => ({ project, code: project, agentId: project })),
        agents: [100, 101, 201].map((contextTokens, i) => ({ id: ["normal", "reminder", "warning"][i], status: "idle", createdAt: null, contextTokens, handoverPath: null, handoverPreview: null, found: true })), todayUsd: {}, now: 0 });
      mounted.unmount();
      mounted = mount(lang, { generatedAt: new Date().toISOString(), supervisorPanel: { rows, tasks: [], details: [], handoffs: [], thresholds }, decisions: [], recentChoices: [], pausedProjects: [], decisionMaint: { enabled: false } });
      await tick();
      const backgrounds = [...mounted.container.querySelectorAll("div")].filter((node: any) => dom.window.getComputedStyle(node).width === "8px" && dom.window.getComputedStyle(node).height === "8px").map((node: any) => dom.window.getComputedStyle(node).backgroundColor);
      assert.equal(backgrounds.length, 3);
      assert.equal(new Set(backgrounds).size, 3);
      const { LIGHT_THEME } = await import("./fixtures/themes");
      const rgb = (color: string) => { const node = dom.window.document.createElement("div"); node.style.color = color; return node.style.color; };
      assert.deepEqual(new Set(backgrounds), new Set([LIGHT_THEME.colors.statusSuccess, LIGHT_THEME.colors.statusWarning, LIGHT_THEME.colors.statusDanger].map(rgb)));
      assert.ok(mounted.container.textContent.includes(lang === "en" ? "red warning" : t("leader.usage.thresholds", { reminder: "0.01", warning: "0.02" }).split("\uFF1A")[0]));
      const button = mounted.container.querySelector(`[aria-label="${t("leader.ui.detailsA11y", { action: t("leader.ui.expand"), code: "warning" })}"]`);
      button.click(); await tick();
      assert.ok(mounted.container.textContent.includes(t("leader.usage.warning")));
    }
    assert.equal(rpcCalls, 0);
  } finally {
    mounted?.unmount(); dom.window.close(); delete g.__leaderRead; delete g.__leaderWrite; delete g.__leaderRpc;
    await rm(dir, { recursive: true, force: true });
  }
});
