/// <reference types="node" />
import { resolveTaskId } from "./card-ref";

export interface ParsedArgs {
  json: boolean;
  cmd: string;
  positionals: string[];
  flag(name: string): string | undefined;
  all(name: string): string[];
  flagNames(): string[];
}

/** `--help` and `-h` anywhere in the argv mean "print usage", including after a subcommand. */
export function wantsHelp(argv: string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h" || arg.startsWith("--help="));
}

export function parseKanbanArgs(argv: string[]): ParsedArgs {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const cmd = args[0] ?? "help";
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      const key = body.slice(0, eq);
      flags.set(key, [...(flags.get(key) ?? []), body.slice(eq + 1)]);
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(body, [...(flags.get(body) ?? []), "true"]);
    else {
      flags.set(body, [...(flags.get(body) ?? []), next]);
      i++;
    }
  }
  return {
    json,
    cmd,
    positionals,
    flag(name: string) {
      return flags.get(name)?.at(-1);
    },
    all(name: string) {
      return flags.get(name) ?? [];
    },
    flagNames() {
      return [...flags.keys()];
    },
  };
}

/**
 * `--parents 11` and the older `--parent 11` both count. Commas and repeats are allowed.
 * A token may be a display code (`DEMO_0001`, `demo_1`) or an old global id (`114`, `#114`).
 */
export function collectParentIds(values: readonly string[]): number[] {
  const ids: number[] = [];
  for (const item of values) {
    for (const part of item.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      ids.push(resolveTaskId(trimmed));
    }
  }
  return ids;
}

export function parentIdsFromArgs(value: unknown): number[] {
  if (Array.isArray(value)) return collectParentIds(value.map((item) => String(item)));
  if (typeof value === "string" || typeof value === "number") return collectParentIds([String(value)]);
  return [];
}

export function parentIdsFromFlags(parsed: ParsedArgs): number[] {
  return collectParentIds([...parsed.all("parents"), ...parsed.all("parent")]);
}
