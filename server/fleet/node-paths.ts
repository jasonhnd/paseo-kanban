/// <reference types="node" />
// Where nvm keeps its Node installs. One place, so access.ts and upgrade-watch.ts agree.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./util";

function nvmNodeRoot(home: string): string {
  return join(home, ".nvm", "versions", "node");
}

/** `<home>/.nvm/versions/node/<version>/bin` for one Node version string such as `v24.1.0`. */
export function nvmVersionBin(version: string, home: string = HOME): string {
  return join(nvmNodeRoot(home), version, "bin");
}

const versionParts = (name: string): number[] => name.replace(/^v/, "").split(".").map((part) => Number(part) || 0);

/** Sort comparator: newest Node version first. Compares major, minor, patch. */
export function compareNodeVersionsDesc(a: string, b: string): number {
  const av = versionParts(a);
  const bv = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (bv[i] ?? 0) - (av[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Every installed nvm Node `bin` directory, newest version first. Empty when nvm is not installed. */
export async function nvmBinDirs(home: string = HOME): Promise<string[]> {
  let versions: string[];
  try {
    versions = await readdir(nvmNodeRoot(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[afc] nvm directory not readable:", String(error).slice(0, 160));
    }
    return [];
  }
  return [...versions].sort(compareNodeVersionsDesc).map((version) => nvmVersionBin(version, home));
}
