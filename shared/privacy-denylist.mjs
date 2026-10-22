const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Same private terms protect repository commits and imported cloud changes. Never copy them to a runner. */
export function parseDenylist(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(term => {
    const literal = /^\/(.+)\/([a-z]*)$/.exec(term);
    const pattern = literal ? new RegExp(literal[1], literal[2].includes("g") ? literal[2] : `${literal[2]}g`) : new RegExp(escapeRegex(term), "gi");
    return { id: "private", pattern, allow: [], onlyPaths: null, literal: literal ? null : term };
  });
}
