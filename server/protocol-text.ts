/// <reference types="node" />
// Long texts written for agents (work rules, leader notes, nudges, the command-line help) live in
// server/protocol/<language>/<name>.md and are read at run time, then `{name}` placeholders are filled
// in. English is the source; zh-CN is the translation. Both languages must have the same files and the
// same placeholders (test/i18n-protocol.test.ts).
//
// Every file is read once, when this module loads: the agent-create hook must not touch the file
// system (test/hook-budget.test.ts), and reading files is not a translation, so it is safe at load.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLanguage, interpolate, LANGUAGES, type Language, type MessageVars } from "../shared/i18n";
import { checkoutRoot, pluginRoot } from "./paths";

const cache = new Map<string, string>();

/**
 * Directories that may hold server/protocol: the checkout this code runs from (command line, tests),
 * then the installation Paseo registered (the daemon runs a bundle with no source URL).
 */
export function protocolDirs(): string[] {
  const roots = [checkoutRoot(), pluginRoot()].filter((root): root is string => Boolean(root));
  return [...new Set(roots)].map((root) => join(root, "server", "protocol"));
}

/** Read every protocol file of every language into the cache. Called once at load; a missing directory leaves the lazy read below. */
function preload(): void {
  for (const dir of protocolDirs()) {
    try {
      for (const language of LANGUAGES) {
        for (const file of readdirSync(join(dir, language))) {
          if (!file.endsWith(".md")) continue;
          const key = `${language}/${file.slice(0, -3)}`;
          if (!cache.has(key)) cache.set(key, readFileSync(join(dir, language, file), "utf8").replace(/\r?\n$/, ""));
        }
      }
      return;
    } catch {
      // try the next directory
    }
  }
}

preload();

function readSource(name: string, language: Language): string | null {
  const key = `${language}/${name}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  for (const dir of protocolDirs()) {
    try {
      // One trailing newline is the file's, not the text's.
      const text = readFileSync(join(dir, language, `${name}.md`), "utf8").replace(/\r?\n$/, "");
      cache.set(key, text);
      return text;
    } catch {
      // try the next directory
    }
  }
  return null;
}

/** The raw text, placeholders unfilled. Falls back to English; throws when neither language has the file. */
export function protocolSource(name: string, language: Language = getLanguage()): string {
  const text = readSource(name, language) ?? (language === "en" ? null : readSource(name, "en"));
  if (text === null) throw new Error(`protocol text ${name} is missing (looked in ${protocolDirs().join(", ")})`);
  return text;
}

/** The text in the current (or given) language with `{name}` placeholders filled in. */
export function protocolText(name: string, vars?: MessageVars, language: Language = getLanguage()): string {
  return interpolate(protocolSource(name, language), vars);
}
