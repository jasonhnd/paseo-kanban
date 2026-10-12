/// <reference types="node" />
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

// CSS named colors, including transparent/currentColor: none is a theme token.
const names = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgrey darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgrey lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor`.split(/\s+/));
import { colorLiterals } from "./helpers/color-source";
function violations(path: string, text: string): string[] { return colorLiterals(text).map(color => `${path}: ${color}`); }

describe("plugin color source guard", () => {
  it("rejects literals, including non-obvious names and template function colors", () => {
    for (const value of ['"#abc"', '"#12345678"', '"rgb(1,2,3)"', '"hsl(20 30% 40%)"', '"transparent"', '"rebeccapurple"', '`rgba(${r},2,3,1)`']) {
      assert.ok(violations("sample.ts", `const color = ${value};`).length > 0, value);
    }
    assert.deepEqual(violations("sample.ts", 'const color = theme.colors.accent;'), []);
  });
  it("allows only the single fallback file under client/ and shared/", () => {
    const root = join(import.meta.dirname, "..");
    const bad: string[] = [];
    for (const dir of ["client", "shared"]) {
      for (const name of readdirSync(join(root, dir), { recursive: true })) {
        if (typeof name !== "string" || !/(?:\.[cm]?[jt]sx?|\.json)$/.test(name)) continue;
        const path = `${dir}/${name}`;
        if (path === "shared/theme-fallback.ts") continue;
        bad.push(...violations(path, readFileSync(join(root, path), "utf8")));
      }
    }
    assert.deepEqual(bad, [], "fixed colors must come from PluginTheme; fixtures live under test/");
  });
});
