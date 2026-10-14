import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

function dataWorkRoot() {
  const home = homedir();
  const pick = (raw) => {
    const value = raw?.trim();
    if (!value) return null;
    if (value === "~") return home;
    if (value.startsWith("~/")) return join(home, value.slice(2));
    return isAbsolute(value) ? value : resolve(value);
  };
  return pick(process.env.KANBAN_DATA_DIR)
    ?? join(pick(process.env.PASEO_HOME) ?? join(home, ".paseo"), "plugin-data", "paseo-kanban");
}

/** Read names only; never create, alter or remove anything in an actual default root. */
export function defaultCardDirectories(cwd = process.cwd()) {
  const found = new Set();
  for (const [root, nested] of [
    ["/tmp", false], ["/private/tmp", false],
    [join(cwd, ".kanban-work"), false],
    [join(dataWorkRoot(), "work"), true],
  ]) {
    let real;
    try { real = realpathSync(root); } catch { continue; }
    const scan = (path, descend) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const child = join(path, entry.name);
        if (/^[A-Za-z0-9]+_\d+$/.test(entry.name)) found.add(child);
        else if (descend) scan(child, false);
      }
    };
    scan(real, nested);
  }
  return [...found].sort();
}

export function newCardDirectories(before, after) {
  const seen = new Set(before);
  return after.filter(path => !seen.has(path));
}
