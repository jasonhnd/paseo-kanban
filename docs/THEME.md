# Host theme colors

Kanban follows Paseo's current theme. There is no independent light/dark palette
or color-mode preference. The adapter targets the eleven semantic colors in
`PluginTheme` from `@getpaseo/plugin` 0.11.0.

## Theme updates

`theme` is a React component prop, inherited by registered screens, workspace
panels and settings from `PluginHostProps`. It is not part of the registration-time
`PluginClientContext`. Read the current prop on every render:

```tsx
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { paletteFromTheme } from "../shared/palette";

function Panel({ theme }: PluginSurfaceProps) {
  const p = paletteFromTheme(theme);
  // Render with p.bg, p.card, p.text and the other derived tokens.
}
```

`useStyles` recalculates from that prop without a theme RPC, polling, subscription
or panel registration. Do not capture the initial theme in module state or an
empty-dependency memo. The same prop contract applies to web and native layouts.

## Palette recipes

`shared/palette.ts` is a pure adapter. Mixing interpolates the host colors'
channels, including alpha; opacity multiplies the host alpha. Generated hex
values work in React Native and web.

| Board token or use | Host source or derivation |
| --- | --- |
| Page and drawer | `surface0` |
| Card | `surface1` |
| Raised surfaces and tracks | `surface2` |
| Column | Equal mix of `surface0` and `surface1` |
| Border | `border` |
| Main text | `foreground` |
| Secondary text and placeholders | `foregroundMuted`, mixed toward `foreground` in .05 steps when page, card or raised-surface contrast is below 4.5:1 |
| Decorative faint dot | Equal mix of `border` and `foregroundMuted` |
| Primary button or selected segment | `accent` and `accentForeground` |
| Status badge background | `surface1` mixed with .1 of the corresponding status token |
| Accent badge background | `surface1` mixed with .1 of `accent` |
| Status and link text | Status token or `accent`, mixed toward `foreground` if needed for 4.5:1 on page, card and badge |
| Clear backgrounds and borders | `surface0` with zero alpha |
| Drawer backdrop | `surface0` with alpha multiplied by .65 |

Hex shorthand, full hex, alpha hex and CSS RGB channels are supported. Unknown
formats retain a supplied host endpoint rather than adding a fixed hue; their
mixing, opacity and contrast adjustment cannot be guaranteed. Readability also
depends on the host's foreground and surface pairs.

## Source and preference rules

1. Use only the eleven host values, their mixes or alpha adjustments. JS/TS
   literals, templates and JSON strings under `client/` and `shared/` are scanned
   by `test/theme-source.test.ts` for hex, RGB/HSL and named-color literals.
   The only source exemption is `shared/theme-fallback.ts`; test fixtures live
   under `test/`. Shared gate scripts remain unchanged.
2. When theme is absent, use the single neutral grayscale theme in
   `shared/theme-fallback.ts`. A supplied theme always wins.
3. Dark/light classification uses only `surface0` relative luminance: linearized
   sRGB, weights .2126/.7152/.0722, threshold .179. No system appearance API is
   read by the plugin. Palette construction does not select a light/dark table.
4. Categories use shades, icons, names or line styles. Providers and roles are
   distinguished by text, and category links share the host accent. Semantic
   success, warning and danger states still use their corresponding host tokens.
5. Tests use light and dark colored fixtures whose eleven values are distinct
   within and across themes. Pure tests cover mappings and every input token.
   Mounted global/project boards on web and simulated iOS update props in place,
   recolor every rendered color, retain an open drawer and check settings.

Legacy `colorMode` is ignored on read and stripped on the next font preference
save, while other unknown fields are preserved. The old migration source stays
untouched. The preference RPC and English/Simplified Chinese UI remove the field
and control; font size remains available.

## Live verification

Use a disposable `paseo --home` environment, a separate loopback port and demo
data, with HOME unchanged. Point all board, Fleet, roles, workspace and temporary
directories into that environment before starting it. Install the candidate
checkout, then select Light and a dark theme through Paseo Appearance. Capture
the global board, actual project workspace panel, drawer and settings in each,
plus a live-switch pair. Stop the disposable daemon afterwards.

Paseo 0.11.2 Web was checked with Light and Midnight. A System light-to-dark
switch updated an already visible project panel in the same document and route,
without navigation or reopening. The host replaced card nodes and closed an open
drawer on a separately checked switch. This is a host remount limitation.

See [toolchain validation](TOOLCHAIN-VALIDATION.md) for local results. Mounted
tests prove state survives a prop update within one plugin instance; they do not
promise the host preserves that instance. A host remount may close an open drawer.
Physical iOS/Android devices and production desktop sessions require separate
verification.

[Simplified Chinese](zh-CN/THEME.md)
