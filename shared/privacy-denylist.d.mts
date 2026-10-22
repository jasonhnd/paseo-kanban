export function parseDenylist(text: string): Array<{ id: string; pattern: RegExp; allow: RegExp[]; onlyPaths: null; literal: string | null }>;
