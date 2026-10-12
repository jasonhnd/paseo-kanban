import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Children, isValidElement, type ReactNode, useMemo, useState } from "react";
import { Pressable, type StyleProp, Text, type TextStyle, View, type ViewStyle } from "react-native";
import { t } from "../../shared/fleet/i18n";
import { DEFAULT_PANEL_PREFS, fontSizes, type PanelPrefs } from "../../shared/fleet/panel-prefs";
import { breakpointForWidth, columnsForWidth, GRID_GAP, gridCellWidth, gridColumns, PANEL_MAX_WIDTH, type Breakpoint } from "../../shared/fleet/responsive";
import { MONO, type Palette, paletteFromTheme, SANS } from "./theme";

export type Theme = PluginSurfaceProps["theme"];
export type Layout = PluginSurfaceProps["layout"];
export type OpenAgent = ((agentId: string) => void) | null;
export type Tone = "green" | "yellow" | "red" | "blue" | "neutral";

export function useStyles(theme: Theme, layout: Layout, prefs: PanelPrefs = DEFAULT_PANEL_PREFS, width = layout.compact ? 402 : 1032) {
  const breakpoint = breakpointForWidth(width);
  const compact = breakpoint === "phone";
  const columns = columnsForWidth(width);
  const p = paletteFromTheme(theme);
  const f = fontSizes(prefs.fontStep, compact);
  return useMemo(() => buildStyles(p, f, breakpoint, columns), [p, f, breakpoint, columns]);
}

function buildStyles(p: Palette, f: ReturnType<typeof fontSizes>, breakpoint: Breakpoint, columns: 1 | 2 | 3) {
  const compact = breakpoint === "phone";
  const bodyLine = Math.round(f.body * 1.45);
  const sans = { fontFamily: SANS };
  const nums = { fontVariant: ["tabular-nums"] as ("tabular-nums")[] };
  return {
    p,
    c: p,
    breakpoint,
    compact,
    columns,
    screen: { flex: 1, backgroundColor: p.bg },
    content: { width: "100%" as const, maxWidth: PANEL_MAX_WIDTH, alignSelf: "center" as const, padding: compact ? 16 : breakpoint === "tablet" ? 24 : 28, gap: compact ? 12 : 24 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
    between: { flexDirection: "row" as const, flexWrap: "wrap" as const, justifyContent: "space-between" as const, alignItems: "center" as const, gap: 12 },
    title: { ...sans, color: p.text, fontSize: f.title, lineHeight: Math.round(f.title * 1.15), fontWeight: "600" as const, letterSpacing: -0.6 },
    h2: { ...sans, color: p.text, fontSize: f.h2, lineHeight: Math.round(f.h2 * 1.3), fontWeight: "600" as const, letterSpacing: -0.3 },
    text: { ...sans, color: p.text, fontSize: f.body, lineHeight: bodyLine },
    muted: { ...sans, color: p.textTertiary, fontSize: f.small, lineHeight: Math.round(f.small * 1.45) },
    secondary: { ...sans, color: p.textSecondary, fontSize: f.small, lineHeight: Math.round(f.small * 1.45) },
    num: { ...sans, ...nums, color: p.text, fontSize: f.body, lineHeight: bodyLine, flexShrink: 0 },
    mono: { fontFamily: MONO, color: p.text, fontSize: f.small, lineHeight: Math.round(f.small * 1.45) },
    card: {
      minWidth: 0,
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: 8,
      padding: 16,
      gap: 8,
      backgroundColor: p.card,
    },
    metric: {
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: 8,
      padding: 16,
      gap: 6,
      backgroundColor: p.card,
    },
    metricValue: { ...sans, ...nums, color: p.text, fontSize: f.metric, lineHeight: Math.round(f.metric * 1.1), fontWeight: "600" as const, letterSpacing: -0.6 },
    metricLabel: { ...sans, color: p.textTertiary, fontSize: f.small, lineHeight: Math.round(f.small * 1.4) },
    item: { borderTopWidth: 1, borderTopColor: p.border, paddingTop: 12, paddingBottom: 12, gap: 6 },
    tabBar: { flexDirection: "row" as const, flexWrap: "nowrap" as const, borderBottomWidth: 1, borderBottomColor: p.border },
    tab: { minHeight: 44, paddingHorizontal: compact ? 12 : 6, paddingVertical: 10, justifyContent: "center" as const, alignItems: "center" as const, borderBottomWidth: 2, borderBottomColor: p.transparent },
    tabActive: { minHeight: 44, paddingHorizontal: compact ? 12 : 6, paddingVertical: 10, justifyContent: "center" as const, alignItems: "center" as const, borderBottomWidth: 2, borderBottomColor: p.blue, backgroundColor: p.primaryBg },
    tabText: { ...sans, color: p.textSecondary, fontSize: f.tab, lineHeight: Math.round(f.tab * 1.3) },
    tabTextActive: { ...sans, ...nums, color: p.primaryFg, fontSize: f.tab, lineHeight: Math.round(f.tab * 1.3), fontWeight: "600" as const },
    button: { minHeight: 44, justifyContent: "center" as const, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: p.primaryBg },
    buttonText: { ...sans, color: p.primaryFg, fontSize: f.body, lineHeight: bodyLine, fontWeight: "600" as const },
    ghost: { minHeight: 44, justifyContent: "center" as const, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: p.border, backgroundColor: p.transparent },
    ghostText: { ...sans, color: p.text, fontSize: f.small, lineHeight: Math.round(f.small * 1.4) },
    badgeText: { ...sans, fontSize: f.small, lineHeight: Math.round(f.small * 1.4), fontWeight: "600" as const },
    segment: {
      flexDirection: "row" as const,
      flexShrink: 0,
      maxWidth: "100%" as const,
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: 6,
      overflow: "hidden" as const,
    },
    segmentItem: {
      minHeight: 44,
      justifyContent: "center" as const,
      paddingHorizontal: compact ? 8 : 10,
      paddingVertical: 6,
      backgroundColor: p.transparent,
      borderLeftWidth: 1,
      borderLeftColor: p.border,
    },
    segmentItemOn: { backgroundColor: p.primaryBg },
    segmentText: { ...sans, color: p.text, fontSize: f.small, lineHeight: Math.round(f.small * 1.3) },
    segmentTextOn: { ...sans, color: p.primaryFg, fontSize: f.small, lineHeight: Math.round(f.small * 1.3), fontWeight: "600" as const },
    dangerText: { ...sans, color: p.red, fontSize: f.small, lineHeight: Math.round(f.small * 1.4), fontWeight: "600" as const },
    red: { ...sans, color: p.red, fontSize: f.small, lineHeight: Math.round(f.small * 1.45), fontWeight: "600" as const },
    yellow: { ...sans, color: p.amber, fontSize: f.small, lineHeight: Math.round(f.small * 1.45), fontWeight: "600" as const },
    green: { ...sans, color: p.green, fontSize: f.small, lineHeight: Math.round(f.small * 1.45), fontWeight: "600" as const },
    blue: { ...sans, color: p.link, fontSize: f.small, lineHeight: Math.round(f.small * 1.45), fontWeight: "600" as const },
    bar: { height: 5, borderRadius: 3, backgroundColor: p.track, overflow: "hidden" as const },
  };
}

export type Styles = ReturnType<typeof useStyles>;

/** Measured locally so nested grids never inherit an unusably narrow three-column slot. */
/** `columns` pins the column count for one grid regardless of the page breakpoint; it still shrinks when cells would drop below minCellWidth. */
export function ResponsiveGrid({ s, children, maxColumns = s.columns, columns: pinned, minCellWidth = 260, cards = false, rowGap = GRID_GAP }: { s: Styles; children: ReactNode; maxColumns?: number; columns?: number; minCellWidth?: number; cards?: boolean; rowGap?: number }) {
  const [width, setWidth] = useState(0);
  const columns = gridColumns(width, pinned ?? Math.min(s.columns, maxColumns), minCellWidth);
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: GRID_GAP, rowGap }}>
      {Children.toArray(children).map((child, index) => (
        <View key={isValidElement(child) ? child.key ?? index : index} style={[{ width: width > 0 ? gridCellWidth(width, columns) : "100%", minWidth: 0, flexShrink: 0 }, cards ? s.card : null]}>{child}</View>
      ))}
    </View>
  );
}

export function pressed(base: StyleProp<ViewStyle>): (state: { pressed: boolean }) => StyleProp<ViewStyle> {
  return ({ pressed: down }) => [base, down ? { opacity: 0.72 } : null];
}

export function toneColor(s: Styles, tone: Tone): string {
  if (tone === "green") return s.p.green;
  if (tone === "yellow") return s.p.amber;
  if (tone === "red") return s.p.red;
  if (tone === "blue") return s.p.link;
  return s.p.hint;
}

function tonePair(s: Styles, tone: Tone): { bg: string; fg: string } {
  if (tone === "green") return { bg: s.p.greenBg, fg: s.p.green };
  if (tone === "yellow") return { bg: s.p.amberBg, fg: s.p.amber };
  if (tone === "red") return { bg: s.p.redBg, fg: s.p.red };
  if (tone === "blue") return { bg: s.p.accentBg, fg: s.p.accent };
  return { bg: s.p.raised, fg: s.p.textSecondary };
}

/** Percentages, counts, amounts, and times keep equal-width digits. */
export function Nums({ style, children }: { style?: StyleProp<TextStyle>; children: string }) {
  const parts = children.split(/(\d+(?:\.\d+)?%?)/g);
  return (
    <Text style={style}>
      {parts.map((part, i) => (
        /^\d/.test(part) ? <Text key={i} style={{ fontVariant: ["tabular-nums"], fontWeight: "600" }}>{part}</Text> : part
      ))}
    </Text>
  );
}

export function StatusDot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

export function Badge({ s, label, tone }: { s: Styles; label: string; tone: Tone }) {
  const pair = tonePair(s, tone);
  return (
    <View style={{ backgroundColor: pair.bg, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, flexShrink: 0 }}>
      <Text style={[s.badgeText, { color: pair.fg }]}>{label}</Text>
    </View>
  );
}

export function Metric({ s, value, label, children }: { s: Styles; value: string; label: string; children?: ReactNode }) {
  return (
    <View style={s.metric}>
      <Text style={s.metricValue}>{value}</Text>
      <Text style={s.metricLabel}>{label}</Text>
      {children}
    </View>
  );
}

export function Track({ s, pct, color, markers }: {
  s: Styles;
  pct: number;
  color: string;
  markers?: Array<{ at: number; color: string }>;
}) {
  const v = Math.max(0, Math.min(100, pct));
  return (
    <View style={{ height: 14, justifyContent: "center" }}>
      <View style={s.bar}>
        <View style={{ width: `${v}%`, height: 5, backgroundColor: color }} />
      </View>
      {markers?.map((mark, i) => (
        <View
          key={`${mark.at}-${i}`}
          style={{ position: "absolute", left: `${Math.max(0, Math.min(100, mark.at))}%`, width: 1, top: 1, bottom: 1, backgroundColor: mark.color }}
        />
      ))}
    </View>
  );
}

export function Fold({ s, title, summary, children }: { s: Styles; title: string; summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? t("ui.fold.collapseLabel", { title }) : t("ui.fold.expandLabel", { title, summary })}
        style={pressed(s.between)}
        onPress={() => setOpen((v) => !v)}
      >
        <Text style={[s.h2, { flexShrink: 1 }]}>{title}</Text>
        <Text style={[s.muted, { fontVariant: ["tabular-nums"], flexShrink: 1 }]}>{summary}{open ? t("ui.fold.collapsedSuffix") : ""}</Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

export function Section({ s, title, hint, extra, children }: { s: Styles; title: string; hint?: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: 12 }}>
      <View style={s.between}>
        <Text style={[s.h2, { flexShrink: 1 }]}>{title}</Text>
        <View style={[s.row, { maxWidth: "100%", flexShrink: 1 }]}>
          {extra}
          {hint ? <Text style={[s.muted, { flexShrink: 1 }]}>{hint}</Text> : null}
        </View>
      </View>
      {children}
    </View>
  );
}

export function Empty({ s, text }: { s: Styles; text: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: s.p.faint }} />
      <Text style={s.muted}>{text}</Text>
    </View>
  );
}

export function Segmented<T extends string>({ s, label, value, options, onChange }: {
  s: Styles;
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; readonly label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={s.segment}>
      {options.map((opt, i) => {
        const on = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="radio"
            accessibilityLabel={t("ui.segmented.optionLabel", { label, option: opt.label })}
            accessibilityState={{ checked: on }}
            aria-checked={on}
            style={pressed([s.segmentItem, i === 0 ? { borderLeftWidth: 0 } : null, on ? s.segmentItemOn : null])}
            onPress={() => onChange(opt.value)}
          >
            <Text style={on ? s.segmentTextOn : s.segmentText}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ s, label, active, onPress }: { s: Styles; label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!active }} style={pressed(active ? s.tabActive : s.tab)} onPress={onPress}>
      <Text style={active ? s.tabTextActive : s.tabText}>{label}</Text>
    </Pressable>
  );
}

export function OpenRow({ s, row, openAgent, label = t("ui.open") }: { s: Styles; row: { agentId: string | null }; openAgent: OpenAgent; label?: string }) {
  return <OpenLink s={s} agentId={row.agentId} openAgent={openAgent} label={label} />;
}

export function OpenLink({ s, agentId, openAgent, label = t("ui.open") }: { s: Styles; agentId: string | null; openAgent: OpenAgent; label?: string }) {
  if (!agentId || !openAgent) return null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} agent`} style={pressed(s.ghost)} onPress={() => openAgent(agentId)}>
      <Text style={s.blue}>{label}</Text>
    </Pressable>
  );
}

export function PctBar({ s, pct }: { s: Styles; pct: number | null }) {
  const v = Math.max(0, Math.min(100, pct ?? 0));
  const color = v >= 90 ? s.p.red : v >= 70 ? s.p.amber : s.p.green;
  return <Track s={s} pct={v} color={color} />;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const sec = (Date.now() - at) / 1000;
  const future = sec < 0;
  const abs = Math.abs(sec);
  const v = abs < 60 ? t("ui.time.underMinute")
    : abs < 3600 ? t("ui.time.minutes", { n: Math.floor(abs / 60) })
    : abs < 86400 ? t("ui.time.hours", { n: Math.floor(abs / 3600) })
    : t("ui.time.days", { n: Math.floor(abs / 86400) });
  return future ? t("ui.time.later", { span: v }) : t("ui.time.ago", { span: v });
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export const STATUS_LABEL: Readonly<Record<string, string>> = {
  get running() { return t("ui.agentStatus.running"); },
  get creating() { return t("ui.agentStatus.starting"); },
  get idle() { return t("ui.agentStatus.idle"); },
  get finished() { return t("ui.agentStatus.finished"); },
  get closed() { return t("ui.agentStatus.closed"); },
  get error() { return t("ui.agentStatus.error"); },
  get initializing() { return t("ui.agentStatus.starting"); },
};
