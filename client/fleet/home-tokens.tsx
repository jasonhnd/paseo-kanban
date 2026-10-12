import { Text, View } from "react-native";
import type { HomeView } from "../../shared/fleet/home-view";
import { barPx, chartMax, dayCaption, daySum, poolSum, shareCaption, shareFlex, stackPx, TOKEN_POOLS, weekSum, type TokenPoolKey } from "../../shared/fleet/token-block";
import { t } from "../../shared/fleet/i18n";
import { fmtZhTokens } from "../../shared/fleet/token-chart";
import { Metric, Nums, ResponsiveGrid, Section, type Styles } from "./ui";

export function TokenBlock({ s, days, shares }: { s: Styles; days: HomeView["days"]; shares: HomeView["roleShares"] }) {
  const colors = s.p.poolColors;
  const max = chartMax(days);
  const total = weekSum(days);
  return (
    <Section s={s} title={t("home.tokens.title")} hint={t("home.tokens.last7Days")}>
      <PoolMetrics s={s} days={days} />
      <PoolLegend s={s} colors={colors} />
      {total === 0 ? <Text style={s.muted}>{t("home.tokens.none")}</Text> : null}
      <DayChart s={s} days={days} max={max} colors={colors} />
      <Text style={s.text}>{t("home.tokens.byWho")}</Text>
      <ShareBar s={s} shares={shares} />
    </Section>
  );
}

function PoolMetrics({ s, days }: { s: Styles; days: HomeView["days"] }) {
  return (
    <ResponsiveGrid s={s}>
      {TOKEN_POOLS.map((pool) => {
        const sum = poolSum(days, pool.key);
        return <View key={pool.key}><Metric s={s} value={sum > 0 ? fmtZhTokens(sum) : "0"} label={t("home.tokens.poolLast7Days", { pool: pool.label })} /></View>;
      })}
    </ResponsiveGrid>
  );
}

function PoolLegend({ s, colors }: { s: Styles; colors: Record<TokenPoolKey, string> }) {
  return (
    <View style={[s.row, { gap: 12 }]}>
      {TOKEN_POOLS.map((pool) => (
        <View key={pool.key} style={s.row}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors[pool.key] }} />
          <Text style={s.muted}>{pool.label}</Text>
        </View>
      ))}
    </View>
  );
}

function DayChart({ s, days, max, colors }: { s: Styles; days: HomeView["days"]; max: number; colors: Record<TokenPoolKey, string> }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, height: 148 }}>
      {days.map((day) => <DayBar key={day.label} s={s} day={day} max={max} colors={colors} />)}
    </View>
  );
}

function DayBar({ s, day, max, colors }: { s: Styles; day: HomeView["days"][number]; max: number; colors: Record<TokenPoolKey, string> }) {
  const sum = daySum(day);
  const bar = barPx(sum, max);
  return (
    <View style={{ flex: 1, alignItems: "center", gap: 4 }}>
      <Nums style={s.muted}>{sum > 0 ? fmtZhTokens(sum) : "0"}</Nums>
      <View style={{ height: 100, width: "78%", justifyContent: "flex-end", borderWidth: day.today ? 1 : 0, borderColor: s.p.text, borderRadius: 4 }}>
        <View style={{ height: stackPx(day.grok, sum, bar), backgroundColor: colors.grok }} />
        <View style={{ height: stackPx(day.cursor, sum, bar), backgroundColor: colors.cursor }} />
        <View style={{ height: stackPx(day.claude, sum, bar), backgroundColor: colors.claude }} />
      </View>
      <Text style={day.today ? s.text : s.muted}>{dayCaption(day)}</Text>
    </View>
  );
}

function ShareBar({ s, shares }: { s: Styles; shares: HomeView["roleShares"] }) {
  return (
    <>
      {shares.length === 0 ? <Text style={s.muted}>{t("home.tokens.noShares")}</Text> : null}
      {shares.length > 0 ? (
        <View style={{ height: 5, borderRadius: 3, overflow: "hidden", flexDirection: "row", backgroundColor: s.p.track }}>
          {shares.map((share, index) => <View key={share.name} style={{ flex: shareFlex(share.pct), backgroundColor: s.p.shareColors[index % s.p.shareColors.length] }} />)}
        </View>
      ) : null}
      <Nums style={s.text}>{shareCaption(shares)}</Nums>
    </>
  );
}
