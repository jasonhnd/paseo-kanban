// Regression mounting complements, but does not replace, real daemon/browser validation.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
import { build } from "esbuild";
import { LIGHT_THEME, DARK_THEME } from "./fixtures/themes";
import { companyCatalog } from "../../../shared/fleet/quota-adapters";
import { buildCompanies } from "../../../shared/fleet/quota-companies";
import { companyWindows } from "../usage-view";
import type { UsagePlan } from "../../../shared/fleet/usage";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("manual Cursor cards retain monitoring warnings and recovery actions on desktop and compact layouts", async () => {
  const now = Date.now();
  const plan = { id: "demo-cursor", name: "Cursor", adapter: "manual", cursorMonitoring: false,
    windows: [], priceUsdMonthly: null, dispatch: false, note: "", providers: ["cursor"], api30dUsd: 0, roi30d: null, coverage: "" } as UsagePlan;
  const companies = buildCompanies({ companies: companyCatalog([plan]), windows: [], pools: {}, profiles: [], cursor: null, now });
  const dir = await mkdtemp(join(tmpdir(), "antigravity-mount-"));
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, any>;
  for (const key of Object.getOwnPropertyNames(dom.window)) if (!(key in g)) try { g[key] = dom.window[key]; } catch {}
  g.window = dom.window; g.document = dom.window.document;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  const tick = () => new Promise(resolve => setTimeout(resolve, 50));
  try {
    const outfile = join(dir, "entry.mjs");
    await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {CompanyCards} from './client/fleet/home-quota'; import {useStyles} from './client/fleet/ui';
      function App({theme,compact,companies,now}){const s=useStyles(theme,{compact,platform:'web'});return <CompanyCards s={s} companies={companies} now={now} showPace cursorFooter={<button>Connect Cursor</button>}/>;}
      export const root=createRoot(document.getElementById('root')); export function render(props){root.render(<App {...props}/>);}`, loader: "tsx", resolveDir: process.cwd() },
      outfile, bundle: true, platform: "node", format: "esm", alias: { "react-native": "react-native-web" }, external: ["react", "react-dom/*", "react-native-web"], jsx: "automatic" });
    // Temp bundle imports resolve against the checkout, without installing or copying dependencies.
    const { symlink } = await import("node:fs/promises");
    await symlink(join(process.cwd(), "node_modules"), join(dir, "node_modules"));
    const mounted = await import(pathToFileURL(outfile).href);
    for (const theme of [LIGHT_THEME, DARK_THEME]) for (const compact of [true, false]) {
      mounted.render({ theme, compact, companies, now }); await tick();
      assert.ok(dom.window.document.body.textContent.includes("Cursor automatic monitoring is off"));
      if (compact) { (dom.window.document.querySelector('[role="button"]') as any).click(); await tick(); }
      assert.ok(dom.window.document.body.textContent.includes("Connect Cursor"));
      const unrelated = companies.map(card => ({ ...card, cursorMonitoring: undefined }));
      mounted.render({ theme, compact: false, companies: unrelated, now }); await tick();
      assert.equal(dom.window.document.body.textContent.includes("Connect Cursor"), false);
    }
    mounted.root.unmount();
  } finally { dom.window.close(); await rm(dir, { recursive: true, force: true }); }
});
