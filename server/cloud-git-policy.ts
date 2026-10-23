/** Local cloud Git operations may use only the filesystem and never run host hooks or filters. */
export const LOCAL_GIT_OPTIONS = ["--no-replace-objects", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always",
  "-c", "core.hooksPath=/dev/null", "-c", "core.attributesFile=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "commit.gpgSign=false"];
export function disabledGitFilters(keys: string): string[] {
  const filters = [...new Set(keys.split("\0").flatMap(key => /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(key)?.[1] ?? []))];
  const merges = [...new Set(keys.split("\0").flatMap(key => /^merge\.(.+)\.driver$/.exec(key)?.[1] ?? []))];
  return [...filters.flatMap(name => ["-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`,
    "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`]),
    ...merges.flatMap(name => ["-c", `merge.${name}.driver=false`])];
}
