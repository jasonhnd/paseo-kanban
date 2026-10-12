import { Text, View } from "react-native";
import { antigravityCountdown, antigravityLeft, antigravityRowStale } from "../../shared/fleet/antigravity-display";
import type { CompanyCard } from "../../shared/fleet/quota-companies";
import { t } from "../../shared/fleet/i18n";
import { Nums, type Styles, Track } from "./ui";

/** Four CLI display windows. ACP protection stays in the backend and never becomes a fifth row here. */
export function AntigravityQuota({ s, company, now }: { s: Styles; company: CompanyCard; now: number }) {
  return <View style={[s.metric, { gap: 16 }]}>
    <View style={[s.row, { gap: 8 }]}>
      <Text accessibilityLabel={t("quota.antigravity.iconA11y")} style={[s.text, { fontWeight: "700", fontSize: 20 }]}>A</Text>
      <Text accessibilityRole="header" style={s.h2}>Antigravity</Text>
    </View>
    <Text style={s.muted}>{t("quota.antigravity.displayPaused")}</Text>
    {company.windows.map((row) => {
      const stale = antigravityRowStale(row, now);
      const source = stale && row.readAt ? t("quota.antigravity.cliStale", { when: row.readAt }) : row.sourceText;
      return <View key={row.id} style={{ gap: 5 }}>
      <View style={[s.between, { alignItems: "flex-start", gap: 8 }]}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={s.text}>{row.name}</Text>
          <View style={[s.row, { gap: 4 }]}>
            <Text accessibilityLabel={t("quota.antigravity.clockA11y")} style={s.muted}>◷</Text>
            <Nums style={s.muted}>{antigravityCountdown(row.resetsAt, now)}</Nums>
          </View>
        </View>
        <Nums style={[s.num, { fontWeight: "600" }]}>{antigravityLeft(row.remainingPct)}</Nums>
      </View>
      <View accessibilityRole="progressbar" accessibilityLabel={row.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.remainingPct ?? undefined} aria-valuetext={antigravityLeft(row.remainingPct)}>
        <Track s={s} pct={row.remainingPct ?? 0} color={row.remainingPct === null ? s.p.track : stale ? s.p.amber : s.p.green} />
      </View>
      <Text style={stale ? s.yellow : s.muted}>{source}</Text>
    </View>; })}
    <Text style={s.muted}>{t("quota.antigravity.claudeShared")}</Text>
  </View>;
}
