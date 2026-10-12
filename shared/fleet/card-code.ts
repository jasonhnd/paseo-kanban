/** Short names from `kanban.config.json` `projects.<name>.code`. */
export type ProjectCodes = Readonly<Record<string, string>>;

/**
 * Display card number: `<CODE>_<code_seq padded to 4>` when the project has a short
 * code and the card has a project-local sequence. Otherwise `#<id>`.
 * `id` stays the primary key; this string is only for what people see.
 */
export function displayCardCode(
  project: string,
  id: number,
  codeSeq: number | null | undefined,
  codes: ProjectCodes,
): string {
  const short = codes[project]?.trim() ?? "";
  if (short && typeof codeSeq === "number" && Number.isInteger(codeSeq) && codeSeq >= 1) {
    return `${short}_${String(codeSeq).padStart(4, "0")}`;
  }
  return `#${id}`;
}
