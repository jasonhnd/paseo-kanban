import { t } from "./i18n";

const CODE_PATTERN = /^[A-Z][A-Z0-9]{0,11}$/;

/** True when `code` is a stored project short code: a letter, then up to 11 letters or digits. */
export function isProjectCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/**
 * First three letters or digits of the project name, uppercased.
 * A name with none of those falls back to PRJ.
 */
export function deriveProjectCode(project: string): string {
  const alnum = project.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return alnum.slice(0, 3) || "PRJ";
}

/**
 * `base` when it is free. Otherwise append 2, 3, … until the code is free.
 * The unsuffixed code stays with whoever already has it.
 */
export function uniqueProjectCode(base: string, taken: ReadonlySet<string>): string {
  const root = base.toUpperCase();
  if (!taken.has(root)) return root;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root}${n}`;
    if (candidate.length > 12) break;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(t("cardCode.noFreeCode", { code: root }));
}

/** Display number: `DEMO_0001`. Four digits, or more when the sequence passes 9999. */
export function formatCardCode(code: string, seq: number): string {
  const n = Math.trunc(seq);
  const width = Math.max(4, String(Math.abs(n)).length);
  return `${code.toUpperCase()}_${String(n).padStart(width, "0")}`;
}

export type CardRef = { kind: "id"; id: number } | { kind: "code"; code: string; seq: number };

/**
 * A display code (`DEMO_0001`, `demo_1`, optional leading `#`) or a global id (`114`, `#114`).
 * Null when the text is neither.
 */
export function parseCardRef(input: string): CardRef | null {
  const text = input.trim();
  const display = /^#?([A-Za-z][A-Za-z0-9]*)_0*(\d+)$/.exec(text);
  if (display) {
    const seq = Number(display[2]);
    if (!Number.isInteger(seq) || seq <= 0) return null;
    const code = display[1].toUpperCase();
    if (!isProjectCode(code)) return null;
    return { kind: "code", code, seq };
  }
  const globalId = /^#?(\d+)$/.exec(text);
  if (!globalId) return null;
  const id = Number(globalId[1]);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { kind: "id", id };
}
