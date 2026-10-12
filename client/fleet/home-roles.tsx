import { Pressable, Text, View } from "react-native";
import type { HomeView } from "../../shared/fleet/home-view";
import { t } from "../../shared/fleet/i18n";
import { fmtZhTokens } from "../../shared/fleet/token-chart";
import { Badge, Empty, Metric, pressed, ResponsiveGrid, Section, type Styles } from "./ui";

export function RoleBlock({ s, cards, onManage }: { s: Styles; cards: HomeView["roleCards"]; onManage?: () => void }) {
  const manage = onManage ? (
    <Pressable accessibilityRole="link" accessibilityLabel={t("roles.home.manageLabel")} style={pressed(s.ghost)} onPress={onManage}>
      <Text style={s.ghostText}>{t("roles.home.manage")}</Text>
    </Pressable>
  ) : undefined;
  return (
    <Section s={s} title={t("roles.home.title")} hint={t("roles.home.hint")} extra={manage}>
      {cards.length === 0 ? <Empty s={s} text={t("roles.home.empty")} /> : null}
      <ResponsiveGrid s={s}>
        {cards.map((card) => (
          <View key={card.name} style={s.card}>
            <View style={[s.between, { flexWrap: "wrap", alignItems: "flex-start" }]}>
              <Text style={s.h2}>{card.name}</Text>
              <Badge s={s} label={card.status} tone={card.tone === "red" ? "red" : card.tone === "yellow" ? "yellow" : "green"} />
            </View>
            <Text style={s.text}>{card.who}</Text>
            <ResponsiveGrid s={s} maxColumns={2} minCellWidth={160}>
              <View>
                <Metric s={s} value={String(card.weekCount)} label={t("roles.home.weekCount")} />
              </View>
              <View>
                <Metric
                  s={s}
                  value={card.tokens === null ? "—" : fmtZhTokens(card.tokens)}
                  label={card.tokens === null ? t("roles.home.tokensMissing") : t("roles.home.tokens")}
                />
              </View>
            </ResponsiveGrid>
            {card.recent.length === 0 ? <Text style={s.muted}>{t("roles.home.noCards")}</Text> : null}
            {card.recent.map((job) => (
              <View key={`${job.code}|${job.project}|${job.title}`} style={{ gap: 2 }}>
                <Text style={s.text}><Text style={s.mono}>{job.code}</Text> · {job.title}</Text>
                <Text style={s.muted}>{job.project}</Text>
              </View>
            ))}
          </View>
        ))}
      </ResponsiveGrid>
    </Section>
  );
}
