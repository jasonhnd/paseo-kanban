import { basename, join } from "node:path";
import { homedir } from "node:os";
import { ALLOWED_EMAIL } from "../shared/public-identity.mjs";
import { readFileSync } from "node:fs";
import { parseDenylist } from "../shared/privacy-denylist.mjs";

export function cloudPrivateDenylistFindings(text: string): string[] {
  const path = process.env.FLEET_PRIVATE_DENYLIST?.trim() || join(homedir(), ".config", "paseo-fleet", "private-denylist.txt");
  const rules = parseDenylist(readFileSync(path, "utf8"));
  return rules.some(rule => text.match(rule.pattern)) ? ["private-denylist"] : [];
}

/** Findings contain categories only, never the private bytes that triggered the gate. */
export function cloudPrivacyFindings(text: string, home = homedir()): string[] {
  const found = new Set<string>();
  if (/\/(?:Users|home)\/|[A-Za-z]:\\Users\\/i.test(text) || text.includes(home)) found.add("local-path");
  const username = basename(home);
  if (username.length > 2 && text.toLowerCase().includes(username.toLowerCase())) found.add("local-username");
  if (/PCC_\d|\b[A-Z]{2,8}[-_]\d{4,}(?:-\d+)?\b/.test(text)) found.add("internal-ticket");
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff01-\uff5e]/u.test(text)) found.add("cjk");
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{20,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer [A-Za-z0-9._~+/-]{24,}/.test(text)) found.add("credential");
  for (const email of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? []) {
    if (!ALLOWED_EMAIL.test(email)) found.add("email");
  }
  return [...found];
}
