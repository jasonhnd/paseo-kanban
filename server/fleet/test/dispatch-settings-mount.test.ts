import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { applyDispatchMatrix, type DispatchMatrix } from "../../../shared/fleet/dispatch";
import { dispatchSettingRows } from "../../../shared/fleet/dispatch-overrides";
import { initializeSettings, readSettings, writeSettings } from "../settings";
import { tIn } from "../../../shared/fleet/i18n";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("mounted settings persist dispatch and operations project, refresh, conflict, clear and translate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-settings-mount-"));
  const data = join(dir, "data");
  const plugin = resolve(import.meta.dirname, "../../..");
  const dom = new JSDOM("<html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, any>;
  for (const key of Object.getOwnPropertyNames(dom.window)) if (!(key in g)) try { g[key] = (dom.window as any)[key]; } catch {}
  g.window = dom.window; g.document = dom.window.document;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0); g.cancelAnimationFrame = clearTimeout;
  const base: DispatchMatrix = { version: 1, defaultTier: "L2", downgradeWhenTight: [], roles: { executor: { L1: [
    { profile: "executor.gpt-6.1-sol", effort: "low" }, { profile: "executor.sonnet", effort: "low" },
  ] }, reviewer: { byExecutorFamily: { anthropic: { L1: [{ profile: "reviewer.gpt-6.1-sol", effort: "medium" }] } } } } };
  const profiles = [
    { name: "Demo GPT", dispatchId: "executor.gpt-6.1-sol", provider: "codex", model: "gpt-6.1-sol" },
    { name: "Demo Sonnet", dispatchId: "executor.sonnet", provider: "claude", model: "demo-sonnet" },
    { name: "Demo reviewer", dispatchId: "reviewer.gpt-6.1-sol", provider: "codex", model: "gpt-6.1-sol" },
  ];
  const catalog = Object.fromEntries(profiles.map(profile => [profile.name, ["low", "medium", "high", "xhigh", "ultra"]]));
  const rows = dispatchSettingRows(base, profiles, catalog);
  let mounted: any;
  try {
    await mkdir(data);
    initializeSettings(data, fileURLToPath(new URL("../../../examples/", import.meta.url)));
    await writeFile(join(data, "afc.config.json"), JSON.stringify({ language: "en", extension: { demo: true } }));
    const snapshot = async () => ({ ...await readSettings("config", data), dispatchRows: rows });
    let pending = 0;
    const tracked = async <T,>(operation: () => Promise<T>): Promise<T> => {
      pending += 1;
      try { return await operation(); } finally { pending -= 1; }
    };
    g.__dispatchRead = () => tracked(snapshot);
    g.__dispatchWrite = (input: Parameters<typeof writeSettings>[0]) => tracked(async () => {
      const result = await writeSettings(input, data);
      return { ...result, snapshot: { ...result.snapshot, dispatchRows: rows } };
    });
    const outfile = join(dir, "entry.mjs");
    await build({
      stdin: { contents: `import {createRoot} from 'react-dom/client'; import {SettingsEditor} from './client/fleet/settings'; import {useStyles} from './client/fleet/ui'; import {LIGHT_THEME} from './server/fleet/test/fixtures/themes';
        function Entry(){const s=useStyles(LIGHT_THEME,{compact:false,platform:'web'});return <SettingsEditor s={s} file="config" read={globalThis.__dispatchRead} write={globalThis.__dispatchWrite}/>;}
        export function mount(){const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);root.render(<Entry/>);return {container,unmount:()=>{root.unmount();container.remove();}};}`,
        resolveDir: plugin, sourcefile: "entry.tsx", loader: "tsx" },
      bundle: true, platform: "node", format: "esm", outfile, jsx: "automatic", logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" }, alias: { "react-native": "react-native-web" },
      plugins: [{ name: "demo-rpc", setup(builder) {
        builder.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: "demo-rpc", namespace: "demo" }));
        builder.onLoad({ filter: /.*/, namespace: "demo" }, () => ({ contents: "export const useRpc = () => () => {};", loader: "js" }));
      } }], banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    });
    const { mount } = await import(pathToFileURL(outfile).href);
    const tick = () => new Promise(resolve => setTimeout(resolve, 80));
    const waitFor = async (condition: () => boolean, label: string) => {
      const deadline = Date.now() + 10_000;
      while (!condition() && Date.now() < deadline) await tick();
      assert.ok(condition(), `Timed out waiting for ${label}`);
    };
    mounted = mount(); await tick(); await tick();
    const click = async (label: string) => {
      const button = mounted.container.querySelector(`[aria-label="${label}"]`);
      assert.ok(button, `Missing action: ${label}`);
      await waitFor(() => pending === 0 && button.getAttribute("aria-disabled") !== "true", label);
      button.click(); await tick();
      await waitFor(() => pending === 0, label);
      await tick();
    };
    const fill = async (label: string, value: string) => {
      const input = mounted.container.querySelector(`input[aria-label="${label}"]`);
      assert.ok(input, `Missing field: ${label}`);
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); await tick();
    };
    assert.match(mounted.container.textContent, /Dispatch depth/);
    assert.equal(mounted.container.querySelector('input[aria-label="Kanban operations project"]').value, "paseo-fleet");
    await fill("Kanban operations project", "Demo operations");
    assert.equal(mounted.container.querySelector('[aria-label="Set Executor · GPT-6.1-Sol / L1 depth to ultra"]'), null);
    await click("Set Executor · GPT-6.1-Sol / L1 depth to medium");
    await fill("Position for Executor · Sonnet (Claude) / L1", "1");
    await click("Save"); await click("Refresh");
    const saved = await snapshot();
    assert.deepEqual(saved.document.extension, { demo: true });
    assert.equal(saved.document.opsProject, "Demo operations");
    assert.equal(mounted.container.querySelector('input[aria-label="Kanban operations project"]').value, "Demo operations");
    assert.deepEqual(saved.document.dispatchOverrides, { executor: { L1: { "executor.gpt-6.1-sol": { effort: "medium" }, "executor.sonnet": { order: 1 } } } });
    const matrix = applyDispatchMatrix(base, { profiles, knownNames: new Set(profiles.map(profile => profile.name)), pools: null, generatedAt: "2030-01-01", dispatchOverrides: saved.document.dispatchOverrides, thinkingCatalog: catalog });
    assert.deepEqual((matrix.roles.executor as any).L1, [{ profile: "Demo Sonnet", effort: "low", order: 1 }, { profile: "Demo GPT", effort: "medium" }]);
    await writeFile(join(data, "afc.config.json"), JSON.stringify({ ...saved.document, extension: { changed: true } }));
    await click("Set Executor · GPT-6.1-Sol / L1 depth to high"); await click("Save");
    assert.match(mounted.container.textContent, /changed elsewhere/);
    await click("Refresh");
    assert.match(mounted.container.textContent, /Override: medium/);
    await fill("Position for Executor · Sonnet (Claude) / L1", "0"); await click("Save");
    assert.match(mounted.container.textContent, /Settings could not be read or saved/);
    await click("Refresh");
    await click("Clear overrides for Executor · Sonnet (Claude) / L1"); await click("Save");
    assert.deepEqual((await snapshot()).document.dispatchOverrides, { executor: { L1: { "executor.gpt-6.1-sol": { effort: "medium" } } } });
    await click("Clear all dispatch overrides"); await click("Save");
    assert.deepEqual((await snapshot()).document.dispatchOverrides, {});
    await click("Simplified Chinese"); await click("Save");
    assert.match(mounted.container.textContent, /\u6d3e\u6d3b\u6df1\u5ea6/);
    await fill(tIn("zh-CN", "settings.opsProject"), "Demo changed");
    await click(tIn("zh-CN", "settings.save"));
    assert.equal((await snapshot()).document.opsProject, "Demo changed");
    mounted.unmount(); mounted = mount(); await tick(); await tick();
    assert.match(mounted.container.textContent, /\u6d3e\u6d3b\u6df1\u5ea6/);
    assert.equal(mounted.container.querySelector(`input[aria-label="${tIn("zh-CN", "settings.opsProject")}"]`).value, "Demo changed");
    await fill(tIn("zh-CN", "settings.opsProject"), "");
    await click(tIn("zh-CN", "settings.save"));
    assert.equal((await snapshot()).document.opsProject, undefined);
    assert.equal(mounted.container.querySelector(`input[aria-label="${tIn("zh-CN", "settings.opsProject")}"]`).value, "paseo-fleet");
    assert.deepEqual(JSON.parse(await readFile(join(data, "afc.config.json"), "utf8")).dispatchOverrides, {});
  } finally {
    mounted?.unmount(); dom.window.close(); delete g.__dispatchRead; delete g.__dispatchWrite;
    await rm(dir, { recursive: true, force: true });
  }
});
