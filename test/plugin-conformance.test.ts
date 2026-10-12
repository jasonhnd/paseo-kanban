/// <reference types="node" />
// Static checks for the official Paseo plugin layout (https://paseo.sh/docs/plugins/reference):
// runtime boundaries, browser globals, host-provided modules, and manifest fields the declared
// minimum Paseo version understands.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const json = (file: string) => JSON.parse(read(file)) as Record<string, unknown>;

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true })
    .filter((name): name is string => typeof name === "string" && /\.(ts|tsx)$/.test(name))
    .map((name) => join(dir, name));
}

/** Module specifiers imported (statically, dynamically, or as types) by one source file. */
function importsOf(file: string): string[] {
  const body = read(file);
  const found = [...body.matchAll(/(?:import|export)[^'"`;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm)];
  return found.map((match) => match[1] ?? match[2] ?? match[3]!);
}

const clientFiles = ["index.client.tsx", ...sources("client")];
const serverFiles = ["index.server.ts", ...sources("server").filter(path => !path.includes("/test/"))];
/**
 * The vendored fleet-quota contract is shared verbatim with the cockpit plugin. Its schema lives in
 * shared/contract/; the parts that need node: modules (paths, io, their tests) live in
 * server/contract/, because Paseo's compiler rejects node: imports in any shared/ file.
 */
const sharedFiles = sources("shared");

/** Host modules Paseo supplies to client code (reference → Runtime modules → Client runtime). */
const CLIENT_HOST = /^(@getpaseo\/plugin(\/client(\/ui|\/react-native)?)?|@tanstack\/react-query|react|react\/jsx-runtime|react-native|zod)$/;

describe("plugin runtime boundaries", () => {
  it("keeps browser globals in client/web.ts only", () => {
    const program = ts.createProgram([...clientFiles, ...sharedFiles].map(p => join(root, p)), { noEmit: true, target: ts.ScriptTarget.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, types: [] });
    const checker = program.getTypeChecker();
    const browser = /(?<![\w.$])(document|window|navigator|localStorage|location)\s*(\?\.|\.|\[)|globalThis\s*as[^)]*\b(document|window|navigator)\b/;
    const offenders = [...clientFiles, ...sharedFiles]
      .filter((file) => file !== join("client", "web.ts"))
      .filter((file) => (() => { const source = program.getSourceFile(join(root, file))!; let bad = false; const visit = (node: ts.Node) => { if (ts.isIdentifier(node) && ["window", "document", "navigator", "location"].includes(node.text) && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) { const symbol = checker.getSymbolAtLocation(node); if (!symbol?.declarations?.some(declaration => declaration.getSourceFile() === source)) bad = true; } ts.forEachChild(node, visit); }; visit(source); return bad; })());
    assert.deepEqual(offenders, []);
  });

  it("client code imports only host modules, client/ and shared/", () => {
    const bad = clientFiles.flatMap((file) => importsOf(file)
      .filter((spec) => (spec.startsWith(".") ? /(^|\/)server\//.test(spec) : !CLIENT_HOST.test(spec)))
      .map((spec) => `${file}: ${spec}`));
    assert.deepEqual(bad, []);
  });

  it("client and cross-runtime shared code import only the contract's schema", () => {
    const bad = [...clientFiles, ...sharedFiles].flatMap((file) => importsOf(file)
      .filter((spec) => /(^|\/)contract(\/(?!schema$)[^/]*)?$/.test(spec))
      .map((spec) => `${file}: ${spec}`));
    assert.deepEqual(bad, []);
  });

  it("tracked shared/ and client/ sources never import a Node module", () => {
    // Paseo's compiler fails the whole build on this, even when only server code reaches the file.
    const tracked = execFileSync("git", ["ls-files", "--", "shared", "client", "index.client.tsx"], { cwd: root, encoding: "utf8" })
      .split("\n").filter((file) => /\.(ts|tsx)$/.test(file));
    assert.ok(tracked.length > 0, "git ls-files found no shared/ or client/ sources");
    const nodeText = /(?:from\s*|require\(\s*|import\(\s*|^\s*import\s+)["']node:|\/\/\/\s*<reference\s+types=["']node["']/m;
    const bad = tracked.flatMap((file) => [
      ...(nodeText.test(read(file)) ? [`${file}: node: import or Node type reference`] : []),
      ...importsOf(file).filter((spec) => isBuiltin(spec)).map((spec) => `${file}: ${spec}`),
    ]);
    assert.deepEqual(bad, []);
  });

  it("server code outside the contract package imports the contract only through server/contract", () => {
    const bad = serverFiles.filter((file) => !file.startsWith(`${join("server", "contract")}/`)).flatMap((file) => importsOf(file)
      .filter((spec) => /(^|\/)contract\/(io|paths|schema)$/.test(spec) || /(^|\/)shared\/contract(\/|$)/.test(spec))
      .map((spec) => `${file}: ${spec}`));
    assert.deepEqual(bad, []);
  });

  it("server code never imports client/ or client-only SDK entries", () => {
    const bad = serverFiles.flatMap((file) => importsOf(file)
      .filter((spec) => /(^|\/)client\//.test(spec) && spec.startsWith(".") || /^@getpaseo\/plugin\/client/.test(spec) || /^react(-native)?$/.test(spec))
      .map((spec) => `${file}: ${spec}`));
    assert.deepEqual(bad, []);
  });

  it("shared code imports only zod, the SDK root and other shared modules", () => {
    const bad = sharedFiles.flatMap((file) => importsOf(file)
      .filter((spec) => !(spec === "zod" || spec === "@getpaseo/plugin" || (spec.startsWith(".") && relative(join(root, "shared"), resolve(root, file, "..", spec)).split(/[\\/]/)[0] !== "..")))
      .map((spec) => `${file}: ${spec}`));
    assert.deepEqual(bad, []);
  });

  it("has no code modules at the plugin root besides the two entries", () => {
    const rootCode = readdirSync(root).filter((name) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name));
    assert.deepEqual(rootCode.sort(), ["index.client.tsx", "index.server.ts"]);
  });

  it("typechecks without the DOM library", () => {
    const tsconfig = json("tsconfig.json") as { compilerOptions: { lib?: string[] } };
    assert.ok(!(tsconfig.compilerOptions.lib ?? []).some((lib) => /^dom/i.test(lib)));
    const refs = clientFiles.filter((file) => /\/\/\/\s*<reference\s+lib=["']dom/i.test(read(file)));
    assert.deepEqual(refs.map((file) => relative(root, join(root, file))), []);
  });
});

describe("package and manifest", () => {
  const pkg = json("package.json") as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  it("keeps host modules and bundled SDK inputs in devDependencies", () => {
    const deps = pkg.dependencies ?? {};
    const dev = pkg.devDependencies ?? {};
    for (const host of ["@getpaseo/plugin", "@tanstack/react-query", "react", "react-native"]) {
      assert.ok(dev[host], `${host} belongs in devDependencies`);
      assert.equal(deps[host], undefined, `${host} is supplied by Paseo at runtime`);
    }
    assert.ok(deps.zod, "zod is imported by the published package");
    assert.equal(dev.zod, undefined, "zod belongs in dependencies");
    assert.equal(deps["@getpaseo/client"], dev["@getpaseo/plugin"], "published Node commands use the pinned SDK runtime dependency");
    assert.equal(deps["@getpaseo/protocol"], dev["@getpaseo/plugin"]);
    assert.equal(deps["@getpaseo/relay"], dev["@getpaseo/plugin"]);
    assert.equal(dev["@getpaseo/client"], undefined);
  });

  it("uses only manifest fields the declared minimum Paseo version accepts", () => {
    const manifest = json("paseo-plugin.json") as { id: string; requirements?: { paseo?: string } };
    assert.equal(manifest.id, "paseo-kanban");
    const range = manifest.requirements?.paseo ?? "";
    const minimum = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(range);
    assert.ok(minimum, `requirements.paseo should be a >= range, got ${range}`);
    const [major, minor] = [Number(minimum[1]), Number(minimum[2])];
    const before011 = major === 0 && minor < 11;
    // Paseo 0.10.x validates the manifest strictly with exactly these keys; name/icon/media need 0.11.
    const allowed = before011 ? ["id", "description", "requirements", "build"] : ["id", "name", "icon", "media", "description", "requirements", "build"];
    assert.deepEqual(Object.keys(manifest).filter((key) => !allowed.includes(key)), []);
  });

  it("prepares acquired sources through a shipped server entry", () => {
    const manifest = json("paseo-plugin.json") as { build: string[][] };
    assert.deepEqual(manifest.build, [["node", "server/prepare.mjs"]]);
    assert.ok(read("server/prepare.mjs").includes("--include=dev"));
  });
});
