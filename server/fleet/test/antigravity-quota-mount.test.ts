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
import { antigravityDisplayWindows, readingFromRun } from "../quota/antigravity-usage";
import { companyCatalog } from "../../../shared/fleet/quota-adapters";
import { buildCompanies } from "../../../shared/fleet/quota-companies";
import { companyWindows } from "../usage-view";
import type { UsagePlan } from "../../../shared/fleet/usage";
import { QUOTA_DISPLAY_TTL_MS } from "../quota-timing";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("phone and desktop mount one four-row card, keep 0/100 bar direction, and expose unknown/stale readings", async () => {
  const now = Date.parse("2028-06-01T00:00:00Z");
  const input = ["Gemini Models\tFive Hour Limit Remaining\t100%\t2028-06-01T05:00:00Z",
    "Gemini Models\tWeekly Limit Remaining\t0%\t2028-06-08T00:00:00Z",
    "Claude and GPT models\tFive Hour Limit Remaining\t95%\t2028-06-01T05:00:00Z",
    "Claude and GPT models\tWeekly Limit Remaining\t97%\t2028-06-08T00:00:00Z"].join("\n");
  const reading = readingFromRun({ stdout: input, stderr: "", code: 0, timedOut: false }, now);
  const plan: UsagePlan = { id: "demo", name: "Antigravity", adapter: "antigravity-cli", windows: [], antigravityDisplay: antigravityDisplayWindows(reading, now),
    priceUsdMonthly: null, dispatch: false, note: "", providers: ["antigravity"], api30dUsd: 0, roi30d: null, coverage: "" };
  const companies = buildCompanies({ companies: companyCatalog([plan]), windows: companyWindows([plan], new Date(now).toISOString()),
    pools: {}, profiles: [], cursor: null });
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
      function App({theme,compact,companies,now}){const s=useStyles(theme,{compact,platform:'web'});return <CompanyCards s={s} companies={companies} now={now} showPace/>;}
      export const root=createRoot(document.getElementById('root')); export function render(props){root.render(<App {...props}/>);}`, loader: "tsx", resolveDir: process.cwd() },
      outfile, bundle: true, platform: "node", format: "esm", alias: { "react-native": "react-native-web" }, external: ["react", "react-dom/*", "react-native-web"], jsx: "automatic" });
    // Temp bundle imports resolve against the checkout, without installing or copying dependencies.
    const { symlink } = await import("node:fs/promises");
    await symlink(join(process.cwd(), "node_modules"), join(dir, "node_modules"));
    const mounted = await import(pathToFileURL(outfile).href);
    for (const theme of [LIGHT_THEME, DARK_THEME]) for (const compact of [true, false]) {
      mounted.render({ theme, compact, companies, now }); await tick();
      assert.equal(dom.window.document.querySelectorAll('[role="heading"]').length, 1);
      const bars = [...dom.window.document.querySelectorAll('[role="progressbar"]')] as any[];
      assert.deepEqual(bars.map(bar => Number(bar.getAttribute("aria-valuenow"))), [100, 0, 95, 97]);
      assert.deepEqual(bars.map(bar => bar.querySelector('[style*="width:"]')?.style.width), ["100%", "0%", "95%", "97%"]);
      const text = dom.window.document.body.textContent;
      assert.ok(text.includes("Shared with GPT") && text.includes("dispatch paused"));
      assert.equal(text.includes("ACP dispatch quota"), false);
    }
    mounted.render({ theme: LIGHT_THEME, compact: true, companies, now: now + QUOTA_DISPLAY_TTL_MS + 1 }); await tick();
    assert.ok(dom.window.document.body.textContent.includes("Expired"));
    assert.ok(dom.window.document.body.textContent.includes(reading.readAt));
    const unknown = companies.map(company => ({ ...company, windows: company.windows.map(row => ({ ...row, remainingPct: null, usedPct: null, readAt: null,
      resetsAt: null, readingExpiresAt: null, readingState: "unknown", sourceText: "Unknown" })) }));
    mounted.render({ theme: DARK_THEME, compact: true, companies: unknown, now }); await tick();
    assert.equal(dom.window.document.querySelectorAll('[role="progressbar"][aria-valuenow]').length, 0);
    assert.equal((dom.window.document.body.textContent.match(/Left unknown/g) ?? []).length, 4);
    mounted.root.unmount();
  } finally { dom.window.close(); await rm(dir, { recursive: true, force: true }); }
});
