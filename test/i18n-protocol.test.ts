/// <reference types="node" />
// Agent-facing texts: server/protocol/<lang>/*.md and the MCP tool descriptions. Both languages must
// have the same files, keys and placeholders, every placeholder must be filled when the text is built,
// and the source code may only name messages that exist.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getLanguage, setLanguage, type Language } from "../shared/i18n";
import { cliFallback, mcpStaleNote } from "../server/fallback";
import { leaderActionNote, noWaitNudge, protocolFor } from "../server/protocol";
import { protocolSource } from "../server/protocol-text";
import { kanbanFallbackNote, supervisorCliNote } from "../server/supervisor";
import { kanbanHelp } from "../server/cli";
import { toolDefs } from "../server/tools";
import { toolText, toolTextKeys } from "../server/tools-text";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const LANGUAGES: Language[] = ["en", "zh-CN"];
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff01-\uff5e]/;
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

const placeholders = (text: string): string[] => [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))].sort();
const protocolNames = (language: Language): string[] =>
  readdirSync(join(root, "server", "protocol", language)).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort();

const initial = getLanguage();
afterEach(() => setLanguage(initial));

describe("protocol texts", () => {
  it("exist in both languages under the same names", () => {
    assert.ok(protocolNames("en").length > 0);
    assert.deepEqual(protocolNames("zh-CN"), protocolNames("en"));
  });

  it("use the same placeholders in both languages", () => {
    const mismatched = protocolNames("en").filter((name) => placeholders(protocolSource(name, "en")).join() !== placeholders(protocolSource(name, "zh-CN")).join());
    assert.deepEqual(mismatched, []);
  });

  it("keep the English files free of Chinese", () => {
    assert.deepEqual(protocolNames("en").filter((name) => CJK.test(protocolSource(name, "en"))), []);
  });

  for (const language of LANGUAGES) {
    it(`build every work rule and note with no placeholder left (${language})`, () => {
      setLanguage(language);
      const texts: Record<string, string> = {
        executor: protocolFor("executor"),
        executorWorktree: protocolFor("executor", { worktree: true }),
        reviewer: protocolFor("reviewer"),
        supervisor: protocolFor("supervisor"),
        reader: protocolFor("reader"),
        decision: protocolFor("decision"),
        batch: protocolFor("batch"),
        cliFallback: cliFallback(),
        mcpStale: mcpStaleNote(),
        nudge: noWaitNudge(),
        leader: leaderActionNote(),
        kanbanFallback: kanbanFallbackNote(),
        supervisorCli: supervisorCliNote(),
        help: kanbanHelp(),
      };
      for (const [name, text] of Object.entries(texts)) {
        assert.ok(text.trim().length > 0, `${name} is empty`);
        assert.deepEqual(placeholders(text), [], `${name} kept a placeholder`);
        if (language === "en") assert.equal(CJK.test(text), false, `${name} has Chinese in English`);
      }
      assert.ok(texts.executor.includes(texts.cliFallback));
      assert.ok(texts.batch.includes(protocolSource("batch-empty-commit", language)));
      assert.ok(texts.supervisor.includes(texts.leader));
    });
  }

  it("documents local checks and external CI waits without imposing a repository-specific CI policy", () => {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguage(language);
      const executor = protocolFor("executor");
      assert.match(executor, /verification/);
      assert.match(executor, /CI.*handoff\.waitingOn/);
      assert.doesNotMatch(executor, /GitHub Actions/);
      assert.match(kanbanHelp(), /waitingOn/);
    }
    setLanguage("en");
    assert.match(protocolFor("executor"), /For repositories without CI/);
    assert.match(leaderActionNote(), /whose local tests and build passed/);
    assert.match(leaderActionNote(), /run the pre-merge checks or run gh pr merge yourself/);
  });

  it("keeps the Chinese work rules the board has always injected", () => {
    setLanguage("zh-CN");
    assert.match(protocolFor("executor"), /^\u770b\u677f\u5de5\u4f5c\u5b88\u5219\uff08\u6267\u884c\uff09\uff1a\n1\. \u5148\u8c03\u7528 kanban_show \u8bfb\u8fd9\u5f20\u5361。/);
    setLanguage("en");
    assert.match(protocolFor("executor"), /^Board work rules \(executor\):\n1\. Read this card with kanban_show first\./);
  });
});

describe("MCP tool descriptions", () => {
  it("have the same keys in both languages", () => {
    assert.deepEqual([...toolTextKeys("zh-CN")].sort(), [...toolTextKeys("en")].sort());
  });

  it("describe every tool and parameter in both languages, English without Chinese", () => {
    const en = toolDefs("en");
    const zh = toolDefs("zh-CN");
    assert.deepEqual(zh.map((tool) => tool.name), en.map((tool) => tool.name));
    en.forEach((tool, index) => {
      const other = zh[index]!;
      assert.ok(tool.description.length > 0 && other.description.length > 0, tool.name);
      assert.notEqual(tool.description, other.description, `${tool.name} is not translated`);
      assert.equal(CJK.test(JSON.stringify(tool)), false, `${tool.name} has Chinese in English`);
      assert.ok(CJK.test(other.description), `${tool.name} has no Chinese in zh-CN`);
    });
  });

  it("keep the schemas identical across languages apart from descriptions", () => {
    const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => (key === "description" ? undefined : item)));
    assert.deepEqual(strip(toolDefs("zh-CN")), strip(toolDefs("en")));
  });

  it("give both decision-id formats wherever a decision id is asked for", () => {
    for (const language of LANGUAGES) {
      for (const key of ["kanban_create.param.decision", "kanban_wait_user.param.decision"] as const) {
        const text = toolText(key, language);
        assert.match(text, /d1005-091216-1/, `${language} ${key}`);
        assert.match(text, /k1005-091216-1/, `${language} ${key}`);
      }
      setLanguage(language);
      assert.match(kanbanHelp(), /d1005-091216-1/);
      assert.match(kanbanHelp(), /k1005-091216-1/);
    }
  });

  it("follow the current language by default", () => {
    setLanguage("en");
    assert.match(toolDefs().find((tool) => tool.name === "kanban_ping")!.description, /^Connectivity check/);
    setLanguage("zh-CN");
    assert.match(toolDefs().find((tool) => tool.name === "kanban_ping")!.description, /^\u8fde\u901a\u6027\u68c0\u67e5/);
  });
});

describe("message references in the source", () => {
  const sourceFiles = ["server", "shared", "client"].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true })
      .filter((name): name is string => typeof name === "string" && /\.(ts|tsx)$/.test(name) && !name.includes("contract"))
      .map((name) => join(dir, name)),
  ).concat(["index.server.ts", "index.client.tsx"]);
  const fleetEn = JSON.parse(readFileSync(join(root, "shared/locales/en/fleet.json"), "utf8")) as Record<string, string>;
  const en = JSON.parse(readFileSync(join(root, "shared", "locales", "en.json"), "utf8")) as Record<string, string>;

  it("name only messages that exist", () => {
    const missing: string[] = [];
    for (const file of sourceFiles) {
      const text = readFileSync(join(root, file), "utf8");
      for (const match of text.matchAll(/\bt\(\s*"([^"]+)"/g)) if (!(match[1] in (/^(?:client|server|shared)\/fleet\//.test(file.replaceAll("\\", "/")) ? fleetEn : en))) missing.push(`${file}: ${match[1]}`);
    }
    assert.deepEqual(missing, []);
  });

  it("name only protocol texts that exist in both languages", () => {
    const names = new Set(protocolNames("en"));
    const missing: string[] = [];
    for (const file of sourceFiles) {
      const text = readFileSync(join(root, file), "utf8");
      for (const match of text.matchAll(/\bprotocolText\(\s*"([^"]+)"/g)) if (!names.has(match[1])) missing.push(`${file}: ${match[1]}`);
    }
    assert.deepEqual(missing, []);
  });
});
