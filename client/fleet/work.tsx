import { Text, View } from "react-native";
import type { BoardSnapshot } from "../../shared/fleet/board";
import { t, tAll } from "../../shared/fleet/i18n";
import { Empty, OpenLink, type OpenAgent, type Styles } from "./ui";

export function KanbanOverview({ s, data }: { s: Styles; data: BoardSnapshot }) {
  return (
    <View style={{ gap: 8 }}>
      {!data.kanban.available ? <Text style={s.muted}>{t("kanban.view.unavailable")}</Text> : null}
      {data.kanban.available ? (
        <View style={s.row}>
          {data.kanban.counts.map((c) => (
            <View key={c.status} style={[s.metric, { alignItems: "flex-start", minWidth: 88, flexGrow: 0 }]}>
              <Text style={s.metricValue}>{c.count}</Text>
              <Text style={c.status === "blocked" && c.count > 0 ? s.red : (c.status === "acceptance" || c.status === "triage") && c.count > 0 ? s.yellow : s.metricLabel}>{c.label}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function WaitingCards({ s, data, openAgent }: { s: Styles; data: BoardSnapshot; openAgent: OpenAgent }) {
  const idleAgent = tAll("queue.category.agentIdle");
  if (!data.kanban.queueShown) return <Empty s={s} text={t("kanban.view.queueUnavailable")} />;
  return (
    <View style={{ gap: 8 }}>
      {data.kanban.waiting.length === 0 ? <Empty s={s} text={t("kanban.view.noneWaiting")} /> : null}
      {data.kanban.waiting.map((row) => (
        <View key={row.id} style={[s.between, s.item]}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={row.alarming && idleAgent.includes(row.category) ? s.red : row.alarming ? s.yellow : s.muted}>
              {row.code} · {row.project} · {row.category} · {row.waitedLabel}
            </Text>
            <Text style={s.text} numberOfLines={2}>{row.title}</Text>
            {row.reason ? <Text style={s.muted} numberOfLines={3}>{row.reason}</Text> : null}
          </View>
          <OpenLink s={s} agentId={row.agentId} openAgent={openAgent} />
        </View>
      ))}
    </View>
  );
}
