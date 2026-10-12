import { tAll } from "./i18n";

/** Old titles (the catalog's `leader.title.oldPrefix` followed by the project) and new titles "<leader> · <project>" are the same role. */
export function isLeaderTitle(title: string): boolean {
  const text = title.trim();
  // Old titles start with the old prefix, renamed ones with "<leader>". Accept both so a renamed session still matches.
  if (tAll("leader.title.oldPrefix").some((prefix) => text.startsWith(prefix))) return true;
  return text === "<leader>" || text.startsWith("<leader> ") || text.startsWith("<leader>·") || text.startsWith("<leader> ·");
}
