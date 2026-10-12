import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
import { buildRolePreview, type Discovery } from "../../../shared/fleet/profile-bootstrap";

test("mounted onboarding generates selectable JSON, retries, and rejects stale responses without writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "onboarding-mount-"));
  const dom = new JSDOM("<html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, any>;
  for (const key of Object.getOwnPropertyNames(dom.window)) if (!(key in g)) try { g[key] = (dom.window as any)[key]; } catch {}
  g.window = dom.window; g.document = dom.window.document;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0); g.cancelAnimationFrame = clearTimeout;
  const plugin = resolve(import.meta.dirname, "../../..");
  const discovery: Discovery = { status: "ready", providers: [{ provider: "demo-provider", state: "discoverable", enabled: true, modes: [], models: [
    { id: "demo-model", label: "Demo model", thinking: [] }, { id: "demo-alternate", label: "Demo alternate", thinking: [] },
  ] }] };
  const calls: string[] = [];
  let delayed: ((result: unknown) => void) | null = null;
  let delay = false;
  let fail = false;
  let previewIssue: "timeout" | "unknown" | null = null;
  g.__roleRpc = async (name: string, input: any) => {
    calls.push(name);
    if (fail) throw new Error("Demo private error detail");
    if (name === "roles.discover") return discovery;
    assert.equal(name, "roles.preview");
    if (previewIssue) return { status: "unavailable", issue: previewIssue, review: "manual", profiles: [] };
    const result = buildRolePreview(discovery, input.executor, input.reviewer, input.language);
    if (delay) return new Promise(resolve => { delayed = resolve; });
    return result;
  };
  let mounted: any;
  try {
    const outfile = join(dir, "entry.mjs");
    await build({
      stdin: { contents: `import {createRoot} from 'react-dom/client'; import {RoleOnboarding} from './client/fleet/onboarding'; import {useStyles} from './client/fleet/ui'; import {LIGHT_THEME} from './server/fleet/test/fixtures/themes'; import {setLanguage} from './shared/fleet/i18n';
        function Entry(){const s=useStyles(LIGHT_THEME,{compact:false,platform:'web'});return <RoleOnboarding s={s}/>;}
        export function mount(lang){setLanguage(lang);const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);root.render(<Entry/>);return {container,unmount:()=>root.unmount()};}`,
        resolveDir: plugin, sourcefile: "entry.tsx", loader: "tsx" },
      bundle: true, platform: "node", format: "esm", outfile, jsx: "automatic", logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" }, alias: { "react-native": "react-native-web" },
      plugins: [{ name: "demo-rpc", setup(builder) {
        builder.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: "demo-rpc", namespace: "demo" }));
        builder.onLoad({ filter: /.*/, namespace: "demo" }, () => ({ contents: "export const useRpc = rpc => input => globalThis.__roleRpc(rpc.name,input);", loader: "js" }));
      } }], banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    });
    const { mount } = await import(pathToFileURL(outfile).href);
    mounted = mount("en");
    const tick = () => new Promise(resolve => setTimeout(resolve, 100));
    await tick();
    const click = async (label: string) => {
      const button = mounted.container.querySelector(`[aria-label="${label}"]`);
      assert.ok(button, `Missing action: ${label}`);
      button.click(); await tick();
    };
    const fill = async (value: string) => {
      const input = mounted.container.querySelector('[aria-label="Model family for Primary roles"]');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); await tick();
    };
    await click("Discover models / retry");
    assert.match(mounted.container.textContent, /does not mean logged in/);
    await click("demo-provider / Demo model"); await fill("openai"); await click("Confirm family for Primary roles");
    assert.match(mounted.container.textContent, /Cursor is a provider, not a model family/);
    await click("Generate preview");
    const json = () => mounted.container.querySelector('[data-testid="role-preview-json"]');
    assert.equal(JSON.parse(json().textContent).length, 5);
    assert.match(mounted.container.textContent, /same model is a self-check/);
    assert.ok(!mounted.container.querySelector('[aria-label="Apply"]'));
    for (const issue of ["timeout", "unknown"] as const) {
      previewIssue = issue;
      await click("Generate preview");
      assert.match(mounted.container.textContent, issue === "timeout" ? /Discovery timed out/ : /Capabilities unknown/);
      assert.doesNotMatch(mounted.container.textContent, /Catalog discovery finished|A selected model is unavailable/);
      assert.equal(json(), null);
      previewIssue = null;
      await click("Discover models / retry");
      await click("demo-provider / Demo model"); await fill("openai"); await click("Confirm family for Primary roles");
    }
    fail = true; await click("Generate preview");
    assert.match(mounted.container.textContent, /Discovery or preview failed/);
    assert.doesNotMatch(mounted.container.textContent, /Catalog discovery finished|private error detail/);
    fail = false; await click("Discover models / retry");
    await click("demo-provider / Demo model"); await fill("openai"); await click("Confirm family for Primary roles");
    delay = true;
    await click("Generate preview");
    await click("demo-provider / Demo alternate");
    assert.ok(delayed);
    (delayed as (value: unknown) => void)({ status: "ready", review: "manual", issue: "none", profiles: [] });
    await tick(); assert.equal(json(), null);
    fail = true; await click("Discover models / retry");
    assert.match(mounted.container.textContent, /Discovery or preview failed/);
    assert.doesNotMatch(mounted.container.textContent, /private error detail/);
    mounted.unmount(); mounted = mount("zh-CN"); await tick();
    assert.match(mounted.container.textContent, /\u4ec5\u9884\u89c8/);
    assert.ok(calls.every(name => ["roles.discover", "roles.preview"].includes(name)));
  } finally {
    mounted?.unmount(); dom.window.close(); delete g.__roleRpc;
    await rm(dir, { recursive: true, force: true });
  }
});
