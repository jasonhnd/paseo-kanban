import { setLanguage as setHostLanguage } from "../../../shared/i18n";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { applyDispatchMatrix, profilesFromConfig } from "../../../shared/fleet/dispatch";
import { DispatchMatrix as ContractMatrix } from "../../../shared/contract/schema";
import { buildDispatchMatrixExport } from "../exports";
import { buildRolesPageView } from "../roles-page";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("mounted Roles panel renders model-filtered exports and refreshes after a live candidate change", async () => {
  setHostLanguage("en");
  const dir = await mkdtemp(join(tmpdir(), "model-review-mount-"));
  const plugin = resolve(import.meta.dirname, "../../..");
  const fixture = JSON.parse(await readFile(new URL("../../contract/test/model-review.fixture.json", import.meta.url), "utf8"));
  let profiles = profilesFromConfig({ daemon: { agentProfiles: fixture.profiles } })!;
  const now = Date.parse("2030-01-01T00:00:00Z");
  const dom = new JSDOM("<html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, any>;
  for (const key of Object.getOwnPropertyNames(dom.window)) if (!(key in g)) try { g[key] = (dom.window as any)[key]; } catch {}
  g.window = dom.window; g.document = dom.window.document;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0); g.cancelAnimationFrame = clearTimeout;
  g.__modelRolesRead = async () => {
    const matrix = applyDispatchMatrix(fixture.base, { profiles, knownNames: new Set(profiles.map(profile => profile.name)), pools: fixture.pools, generatedAt: new Date(now).toISOString() });
    const parsed = ContractMatrix.parse(buildDispatchMatrixExport(matrix, "demo", new Date(now)));
    return buildRolesPageView({ profiles: async () => profiles, pools: async () => fixture.pools, runsSince: () => [],
      baseMatrix: async () => ({ ...parsed, priority: parsed.priority ?? undefined }) }, now);
  };
  let mounted: any;
  try {
    const outfile = join(dir, "entry.mjs");
    await build({
      stdin: { contents: `import {createRoot} from 'react-dom/client'; import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {RolesTab} from './client/fleet/roles'; import {useStyles} from './client/fleet/ui'; import {LIGHT_THEME} from './server/fleet/test/fixtures/themes'; import {setLanguage} from './shared/fleet/i18n';
        const query=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
        function Entry(){const s=useStyles(LIGHT_THEME,{compact:false,platform:'web'});return <RolesTab s={s} models={[]}/>;}
        export function mount(){setLanguage('en');const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);root.render(<QueryClientProvider client={query}><Entry/></QueryClientProvider>);
        return {container,refresh:()=>query.invalidateQueries({queryKey:['afc','roles']}),unmount:()=>{root.unmount();query.clear();container.remove();}};}`,
        resolveDir: plugin, sourcefile: "entry.tsx", loader: "tsx" },
      bundle: true, platform: "node", format: "esm", outfile, jsx: "automatic", logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" }, alias: { "react-native": "react-native-web" },
      plugins: [{ name: "isolated-model-rpc", setup(builder) {
        builder.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: "model-rpc", namespace: "demo" }));
        builder.onLoad({ filter: /.*/, namespace: "demo" }, () => ({ contents: "export const useRpc = rpc => rpc.name === 'board.roles-page' ? globalThis.__modelRolesRead : () => { throw new Error('No mutations authorized'); };", loader: "js" }));
      } }], banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    });
    const { mount } = await import(pathToFileURL(outfile).href);
    mounted = mount();
    const line = () => [...mounted.container.querySelectorAll("div")].map((node: any) => node.textContent)
      .find(text => text.startsWith("When the actual executor model is demo-alpha,") && !text.includes("When the actual executor model is demo-beta,"));
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(predicate(), mounted.container.textContent);
    };
    await waitFor(() => Boolean(line()));
    assert.match(line(), /L2 Demo same family reviewer/);
    assert.ok(!line().includes("Demo same model reviewer"));
    assert.ok(!line().includes("Demo unknown reviewer"));
    profiles = profiles.map(profile => profile.name === "Demo same family reviewer" ? { ...profile, model: "demo-alpha" } : profile);
    await mounted.refresh();
    await waitFor(() => line()?.includes("L2 Demo ordinary reviewer") === true);
    assert.ok(!line().includes("Demo same family reviewer"));
    assert.ok(!line().includes("Demo paused reviewer"));
  } finally {
    mounted?.unmount(); dom.window.close(); delete g.__modelRolesRead;
    await rm(dir, { recursive: true, force: true });
  }
});
