import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Pressable, type StyleProp, Text, View, type ViewStyle } from "react-native";
import { t } from "../shared/i18n";
import { DEFAULT_PANEL_PREFS, fontSizes, type PanelPrefs } from "../shared/panel-prefs";
import { MONO, type Palette, paletteFromTheme, SANS } from "./theme";

export type Theme = PluginSurfaceProps["theme"];
export type Layout = PluginSurfaceProps["layout"];
export type Tone = "success" | "warning" | "danger" | "accent" | "neutral";

export function useStyles(theme: Theme, layout: Layout, prefs: PanelPrefs = DEFAULT_PANEL_PREFS, narrow = false) {
  const compact = layout.compact;
  const p = paletteFromTheme(theme);
  const f = fontSizes(prefs.fontStep, compact);
  return useMemo(() => buildStyles(p, f, compact, narrow), [p, f, compact, narrow]);
}

/** Columns narrower than this stack into one: at 768 the three columns are ~225px each and cut every title. */
export const COLUMN_MIN_WIDTH = 280;

function buildStyles(p: Palette, f: ReturnType<typeof fontSizes>, compact: boolean, narrow: boolean) {
  const bodyLine = Math.round(f.body * 1.45);
  const smallLine = Math.round(f.small * 1.45);
  const sans = { fontFamily: SANS };
  const nums = { fontVariant: ["tabular-nums"] as ("tabular-nums")[] };
  const hit = narrow ? 44 : undefined;
  const labelWidth = Math.ceil(f.small * 5.6);
  const columnFrame = {
    gap: 8,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: p.border,
    backgroundColor: p.column,
    alignSelf: "stretch" as const,
    minWidth: 0,
  };
  return {
    p,
    screen: { flex: 1, backgroundColor: p.bg },
    content: { padding: compact ? 16 : 28, gap: compact ? 24 : 32 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
    between: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, gap: 12, flexWrap: "wrap" as const },
    title: { ...sans, color: p.text, fontSize: f.title, lineHeight: Math.round(f.title * 1.15), fontWeight: "600" as const, letterSpacing: -0.6 },
    h2: { ...sans, color: p.text, fontSize: f.h2, lineHeight: Math.round(f.h2 * 1.3), fontWeight: "600" as const, letterSpacing: -0.3 },
    text: { ...sans, ...nums, color: p.text, fontSize: f.body, lineHeight: bodyLine },
    muted: { ...sans, ...nums, color: p.textTertiary, fontSize: f.small, lineHeight: smallLine },
    secondary: { ...sans, ...nums, color: p.textSecondary, fontSize: f.small, lineHeight: smallLine },
    mono: { fontFamily: MONO, ...nums, color: p.textSecondary, fontSize: f.small, lineHeight: smallLine },
    count: { fontFamily: MONO, ...nums, color: p.text, fontSize: f.h2, lineHeight: Math.round(f.h2 * 1.3), fontWeight: "600" as const },
    cardTitle: { ...sans, color: p.text, fontSize: f.body, lineHeight: bodyLine, fontWeight: "600" as const },
    card: {
      alignSelf: "stretch" as const,
      minWidth: 0,
      maxWidth: "100%" as const,
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: 8,
      padding: 16,
      gap: 8,
      backgroundColor: p.card,
    },
    cardBody: { alignSelf: "stretch" as const, minWidth: 0, maxWidth: "100%" as const, gap: 8 },
    cardHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
    facts: { alignSelf: "stretch" as const, gap: 6, maxWidth: "100%" as const },
    identity: {
      alignSelf: "stretch" as const,
      maxWidth: "100%" as const,
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "flex-start" as const,
      columnGap: 12,
      rowGap: 2,
    },
    /** A footer item stays inside the card so a long line wraps instead of spilling out. */
    identityItem: { maxWidth: "100%" as const, minWidth: 0, flexShrink: 1 },
    identityText: { ...sans, ...nums, flexShrink: 1, minWidth: 0, color: p.textSecondary, fontSize: f.small, lineHeight: smallLine },
    identityLink: { ...sans, ...nums, flexShrink: 1, minWidth: 0, color: p.accent, fontSize: f.small, lineHeight: smallLine },
    fact: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8, alignSelf: "stretch" as const, maxWidth: "100%" as const },
    factLabel: { ...sans, width: labelWidth, flexShrink: 0, color: p.textSecondary, fontSize: f.small, lineHeight: smallLine },
    factValue: { ...sans, ...nums, flex: 1, flexShrink: 1, minWidth: 0, color: p.text, fontSize: f.body, lineHeight: bodyLine },
    column: narrow || compact
      ? { ...columnFrame, width: "100%" as const }
      : { ...columnFrame, flexGrow: 1, flexShrink: 1, flexBasis: 0 },
    /** Width a card needs to keep number, 12 title characters and a four-character badge on one line. */
    cardRoomy: Math.ceil(f.small * 6 + f.body * 12 + 100),
    /** What each badge character beyond four adds to that width. */
    badgeChar: f.small,
    columnsStacked: { width: "100%" as const, gap: 16 },
    columnStacked: { ...columnFrame, width: "100%" as const },
    columns: narrow || compact
      ? { width: "100%" as const, gap: 16 }
      : {
          width: "100%" as const,
          flexDirection: "row" as const,
          alignItems: "stretch" as const,
          gap: 16,
        },
    button: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      minHeight: hit,
      justifyContent: "center" as const,
      borderRadius: 6,
      backgroundColor: p.primaryBg,
    },
    buttonText: { ...sans, color: p.primaryFg, fontSize: f.body, lineHeight: bodyLine, fontWeight: "600" as const, textAlign: "center" as const },
    ghost: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      minHeight: hit,
      justifyContent: "center" as const,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: p.border,
      backgroundColor: p.clear,
    },
    ghostText: { ...sans, color: p.text, fontSize: f.small, lineHeight: smallLine, textAlign: "center" as const },
    danger: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      minHeight: hit,
      justifyContent: "center" as const,
      borderRadius: 6,
      backgroundColor: p.clear,
    },
    dangerText: { ...sans, color: p.danger, fontSize: f.small, lineHeight: smallLine, fontWeight: "600" as const, textAlign: "center" as const },
    badgeText: { ...sans, fontSize: f.small, lineHeight: smallLine, fontWeight: "600" as const },
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
      paddingHorizontal: compact ? 8 : 10,
      paddingVertical: 6,
      minHeight: hit,
      justifyContent: "center" as const,
      backgroundColor: p.clear,
      borderLeftWidth: 1,
      borderLeftColor: p.border,
    },
    segmentItemOn: { backgroundColor: p.primaryBg },
    segmentText: { ...sans, color: p.text, fontSize: f.small, lineHeight: Math.round(f.small * 1.3) },
    segmentTextOn: { ...sans, color: p.primaryFg, fontSize: f.small, lineHeight: Math.round(f.small * 1.3), fontWeight: "600" as const },
    tab: { paddingHorizontal: 12, paddingVertical: 10, minHeight: hit, justifyContent: "center" as const, borderBottomWidth: 2, borderBottomColor: p.clear, marginBottom: -1 },
    tabActive: { paddingHorizontal: 12, paddingVertical: 10, minHeight: hit, justifyContent: "center" as const, borderBottomWidth: 2, borderBottomColor: p.text, marginBottom: -1, backgroundColor: p.clear },
    tabText: { ...sans, color: p.textSecondary, fontSize: f.tab, lineHeight: Math.round(f.tab * 1.3) },
    tabTextActive: { ...sans, ...nums, color: p.text, fontSize: f.tab, lineHeight: Math.round(f.tab * 1.3), fontWeight: "600" as const },
    tabBar: { flexDirection: "row" as const, flexWrap: "nowrap" as const, borderBottomWidth: 1, borderBottomColor: p.border },
    boardTab: { minHeight: 44, paddingHorizontal: narrow ? 12 : 14, paddingVertical: 8, justifyContent: "center" as const, flexShrink: 0, borderBottomWidth: 2, borderBottomColor: p.clear, marginBottom: -1 },
    boardTabActive: { minHeight: 44, paddingHorizontal: narrow ? 12 : 14, paddingVertical: 8, justifyContent: "center" as const, flexShrink: 0, borderBottomWidth: 2, borderBottomColor: p.accent, marginBottom: -1, backgroundColor: p.raised },
    compactCard: {
      alignSelf: "stretch" as const,
      minWidth: 0,
      maxWidth: "100%" as const,
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      gap: 2,
      minHeight: hit,
      backgroundColor: p.card,
    },
    compactLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, minWidth: 0, maxWidth: "100%" as const },
    overlay: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, flexDirection: "row" as const, justifyContent: "flex-end" as const, zIndex: 10 },
    backdrop: { position: "absolute" as const, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: p.backdrop },
    drawer: {
      width: "100%" as const,
      maxWidth: narrow ? ("100%" as const) : 620,
      height: "100%" as const,
      backgroundColor: p.bg,
      borderLeftWidth: narrow ? 0 : 1,
      borderLeftColor: p.border,
    },
    command: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, borderWidth: 1, borderColor: p.border, borderRadius: 6, paddingLeft: 10, backgroundColor: p.raised },
    input: {
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      minHeight: hit,
      color: p.text,
      backgroundColor: p.bg,
      fontSize: f.body,
      fontFamily: SANS,
      minWidth: narrow ? 0 : 180,
      flexGrow: 1,
    },
    warn: { ...sans, color: p.warning, fontSize: f.small, lineHeight: smallLine, fontWeight: "600" as const },
    bad: { ...sans, color: p.danger, fontSize: f.small, lineHeight: smallLine, fontWeight: "600" as const },
    yellow: { ...sans, color: p.warning, fontSize: f.small, lineHeight: smallLine, fontWeight: "600" as const },
    red: { ...sans, color: p.danger, fontSize: f.small, lineHeight: smallLine, fontWeight: "600" as const },
    banner: {
      borderWidth: 1,
      borderColor: p.border,
      borderLeftWidth: 2,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: p.clear,
    },
    bannerText: { ...sans, fontSize: f.small, lineHeight: smallLine, fontWeight: "600" as const },
    alert: { borderLeftWidth: 2, paddingLeft: 8, alignSelf: "stretch" as const, maxWidth: "100%" as const },
    listRow: { borderTopWidth: 1, borderTopColor: p.border, paddingVertical: 12, alignSelf: "stretch" as const, maxWidth: "100%" as const, gap: 4 },
  };
}

export type Styles = ReturnType<typeof useStyles>;

export function pressed(base: StyleProp<ViewStyle>): (state: { pressed: boolean }) => StyleProp<ViewStyle> {
  return ({ pressed: down }) => [base, down ? { opacity: 0.72 } : null];
}

function tonePair(s: Styles, tone: Tone): { bg: string; fg: string } {
  if (tone === "success") return { bg: s.p.successBg, fg: s.p.success };
  if (tone === "warning") return { bg: s.p.warningBg, fg: s.p.warning };
  if (tone === "danger") return { bg: s.p.dangerBg, fg: s.p.danger };
  if (tone === "accent") return { bg: s.p.accentBg, fg: s.p.accent };
  return { bg: s.p.raised, fg: s.p.textSecondary };
}

/** `fit` keeps the badge inside its row: one line, cut with an ellipsis instead of growing past the card. */
export function Badge({ s, label, tone, dot = false, fit = false }: { s: Styles; label: string; tone: Tone; dot?: boolean; fit?: boolean }) {
  const pair = tonePair(s, tone);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: pair.bg, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, flexShrink: fit ? 1 : 0, minWidth: 0, maxWidth: "100%" }}>
      {dot ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: pair.fg, flexShrink: 0 }} /> : null}
      <Text numberOfLines={fit ? 1 : undefined} style={[s.badgeText, { color: pair.fg }, fit ? { flexShrink: 1, minWidth: 0 } : null]}>{label}</Text>
    </View>
  );
}

export function Button({
  s,
  label,
  tone = "primary",
  onPress,
  accessibilityLabel,
  disabled = false,
}: {
  s: Styles;
  label: string;
  tone?: "primary" | "secondary" | "danger";
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
}) {
  const base = tone === "primary" ? s.button : tone === "danger" ? s.danger : s.ghost;
  const text = tone === "primary" ? s.buttonText : tone === "danger" ? s.dangerText : s.ghostText;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled }} disabled={disabled} style={pressed(disabled ? { ...base, opacity: 0.45 } : base)} onPress={disabled ? undefined : onPress}>
      <Text style={text}>{label}</Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({
  s,
  label,
  value,
  options,
  onChange,
}: {
  s: Styles;
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
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
            accessibilityLabel={`${label}${t("common.colon")}${opt.label}`}
            accessibilityState={{ selected: on }}
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

export function Empty({ s, text }: { s: Styles; text: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: s.p.faint }} />
      <Text style={s.muted}>{text}</Text>
    </View>
  );
}

export function Fact({
  s,
  label,
  value,
  tone = "text",
}: {
  s: Styles;
  label: string;
  value: string;
  tone?: "text" | "warning" | "danger" | "accent";
}) {
  const color = tone === "danger" ? s.p.danger : tone === "warning" ? s.p.warning : tone === "accent" ? s.p.accent : s.p.text;
  return (
    <View style={s.fact}>
      <Text style={s.factLabel}>{label}</Text>
      <Text style={[s.factValue, { color }]}>{value}</Text>
    </View>
  );
}

export function AlertLine({ s, tone, text }: { s: Styles; tone: "warning" | "danger"; text: string }) {
  const color = tone === "danger" ? s.p.danger : s.p.warning;
  return (
    <View style={[s.alert, { borderLeftColor: color }]}>
      <Text style={[s.muted, { color }]}>{text}</Text>
    </View>
  );
}

export function Banner({ s, tone, text }: { s: Styles; tone: "warning" | "danger"; text: string }) {
  const color = tone === "danger" ? s.p.danger : s.p.warning;
  return (
    <View style={[s.banner, { borderLeftColor: color }]}>
      <Text style={[s.bannerText, { color }]}>{text}</Text>
    </View>
  );
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function blockedFor(iso: string | null): string {
  if (!iso) return t("ui.duration.unknown");
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return t("ui.duration.justBlocked");
  return elapsed(iso);
}

/** How long ago, in the same words the board uses everywhere. */
export function elapsed(iso: string | null): string {
  if (!iso) return t("ui.duration.unknown");
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return t("ui.duration.unknown");
  if (ms < 0) return t("ui.duration.justNow");
  const min = Math.floor(ms / 60000);
  if (min < 1) return t("ui.duration.underMinute");
  if (min < 60) return t("ui.duration.minutes", { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 48) return t("ui.duration.hours", { count: hr });
  return t("ui.duration.days", { count: Math.floor(hr / 24) });
}
