// Advisory only: prefer missed hints to warnings on ordinary nouns or acceptance lists.
// This is intentionally a small bilingual action vocabulary, not a task classifier.
const ACTION = /^(?:(?:fix|add|implement|update|migrate|remove|delete|refactor|build|create|write|translate|audit|investigate|test|verify)\s+\S|(?:\u4fee\u590d|\u65b0\u589e|\u5b9e\u73b0|\u66f4\u65b0|\u8fc1\u79fb|\u5220\u9664|\u91cd\u6784|\u6784\u5efa|\u521b\u5efa|\u7f16\u5199|\u7ffb\u8bd1|\u5ba1\u67e5|\u8865\u5145|\u8865|\u4fee\u6539|\u8c03\u6574|\u4f18\u5316|\u6d4b\u8bd5)\s*\S)/i;
const WORK_HEADING = /^(?:tasks?|work|scope|implementation|\u8981\u505a|\u4efb\u52a1|\u6539\u52a8\u8303\u56f4|\u8303\u56f4|\u76ee\u6807)(?:\s*[:\uff1a]\s*|$)/i;
const NON_WORK_HEADING = /^(?:acceptance(?:\s+criteria)?|verification|tests?|constraints?|background|risks?|\u9a8c\u6536\u6807\u51c6|\u9a8c\u6536|\u9a8c\u8bc1|\u6d4b\u8bd5|\u7981\u6b62|\u7ea6\u675f|\u80cc\u666f|\u98ce\u9669)(?:\s*[:\uff1a]\s*|$)/i;

function parallelActions(line: string): boolean {
  return line.split(/[;\uff1b+\uff0b\u3001]/).filter(part => ACTION.test(part.trim())).length >= 2;
}

function workLines(brief: string): string[] {
  const lines: string[] = [];
  let work = true;
  let fenced = false;
  for (const raw of brief.split(/\r?\n/)) {
    const line = raw.trim().replace(/^#{1,6}\s+/, "");
    if (/^```|^~~~/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const heading = WORK_HEADING.exec(line);
    if (heading || NON_WORK_HEADING.test(line)) {
      work = Boolean(heading);
      // A section boundary also separates numbered lists.
      lines.push("\0");
      if (heading) lines.push(line.slice(heading[0].length));
      continue;
    }
    if (work) lines.push(line);
  }
  return lines;
}

function multipleActions(title: string, lines: string[]): boolean {
  if (parallelActions(title)) return true;
  let numbered = 0;
  for (const line of lines) {
    if (line === "\0") { numbered = 0; continue; }
    if (!line) continue;
    const item = /^\d+[.)\u3001\uff09]\s*(.+)$/.exec(line);
    if (item && ACTION.test(item[1]) && ++numbered >= 3) return true;
    if (parallelActions(line.replace(/^(?:\d+[.)\u3001\uff09]|[-*])\s*/, ""))) return true;
  }
  return false;
}

function longEstimate(brief: string): boolean {
  // Require an estimate label immediately before the duration. Do not interpret
  // timeout/retention values elsewhere in a brief as the task's running time.
  const estimates = /(?:\bestimat(?:e|ed)(?:\s+(?:duration|time|effort))?|\u9884\u8ba1(?:\u8017\u65f6|\u65f6\u957f)?)[\s:\uff1a]*(over\s+|more than\s+|>|\u8d85\u8fc7\s*)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b|h(?=\s*\d)|\u5c0f\u65f6|minutes?|mins?|m\b|\u5206\u949f)(?:\s*(\d+)\s*(?:minutes?|mins?|m\b|\u5206\u949f))?/gi;
  for (const match of brief.matchAll(estimates)) {
    const hours = /^(?:h|\u5c0f)/i.test(match[3]);
    const minutes = Number(match[2]) * (hours ? 60 : 1) + (hours ? Number(match[4] ?? 0) : 0);
    if (minutes > 60 || (minutes === 60 && match[1])) return true;
  }
  return false;
}

export function needsSplitHint(title: string, brief: string): boolean {
  const lines = workLines(brief);
  return longEstimate(lines.join("\n")) || multipleActions(title, lines);
}
