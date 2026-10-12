import { Pressable, Text, View } from "react-native";
import { t } from "../shared/i18n";
import { LEADER_LABEL, roleLabel } from "../shared/labels";
import { Button, Empty, type Styles } from "./ui";
import { ReviewPreview } from "./review-preview";

interface AgentRow {
  id: string;
  title: string;
  closed: boolean;
  role: string | null;
}

export interface SettingsData {
  project: string;
  autoStart: boolean | null;
  projectSupervisorId: string | null;
  supervisorAgentId: string | null;
  poolMessage: string;
  concurrency: { global: number; pools: Record<string, number>; roles: Record<string, number> } | null;
  agents: { note: string | null; suggestedId: string | null; agents: AgentRow[] } | undefined;
}

/** Per-project switches and leader registration. Moved out of the board's top area into its own tab. */
export function SettingsPanel({ s, data, onToggleAuto, onSetLeader, onSetFallback }: {
  s: Styles;
  data: SettingsData;
  onToggleAuto: () => void;
  onSetLeader: (agentId: string) => unknown;
  onSetFallback: (agentId: string) => unknown;
}) {
  const { project, agents } = data;
  return (
    <View testID="settings-panel" style={s.card}>
      <ReviewPreview s={s} />
      <Text style={s.h2}>{t("boardView.tab.settings")}</Text>
      <View style={s.row}>
        <Button
          s={s}
          label={t("settingsPanel.autoStart.button", { state: project ? (data.autoStart ? t("settingsPanel.autoStart.on") : t("settingsPanel.autoStart.off")) : t("settingsPanel.autoStart.pickProject") })}
          tone={project && data.autoStart ? "primary" : "secondary"}
          accessibilityLabel={t("settingsPanel.autoStart.label")}
          onPress={onToggleAuto}
        />
      </View>
      <Text style={s.muted}>{t("settingsPanel.leader.intro", { leader: LEADER_LABEL })}</Text>
      {!project ? <Text style={s.muted}>{t("settingsPanel.leader.pickProject", { leader: LEADER_LABEL })}</Text> : null}
      {agents?.note ? <Text style={s.muted}>{agents.note}</Text> : null}
      {agents?.suggestedId ? (
        <Text style={s.muted}>{t("settingsPanel.leader.suggested", { leader: LEADER_LABEL, title: agents.agents.find((item) => item.id === agents.suggestedId)?.title ?? agents.suggestedId.slice(0, 8) })}</Text>
      ) : null}
      {project && !agents?.note && (agents?.agents ?? []).length === 0 ? <Empty s={s} text={t("settingsPanel.leader.noAgents")} /> : null}
      {(agents?.agents ?? []).map((item) => {
        const on = item.id === data.projectSupervisorId;
        return (
          <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={t("settingsPanel.leader.register", { leader: LEADER_LABEL, title: item.title })} style={on ? s.button : s.ghost} onPress={() => void onSetLeader(on ? "" : item.id)}>
            <Text style={on ? s.buttonText : s.ghostText}>{item.title} · {item.id.slice(0, 8)}{item.role ? ` · ${roleLabel(item.role)}` : ""}{item.closed ? ` · ${t("settingsPanel.agent.closed")}` : ""}</Text>
          </Pressable>
        );
      })}
      <Text style={s.h2}>{t("settingsPanel.fallback.title", { leader: LEADER_LABEL })}</Text>
      <Text style={s.muted}>{t("settingsPanel.fallback.intro", { leader: LEADER_LABEL })}</Text>
      {data.supervisorAgentId ? <Text style={s.mono}>{t("settingsPanel.fallback.current", { agent: data.supervisorAgentId.slice(0, 8) })}</Text> : <Text style={s.muted}>{t("settingsPanel.fallback.none", { leader: LEADER_LABEL })}</Text>}
      {(agents?.agents ?? []).map((item) => {
        const on = item.id === data.supervisorAgentId;
        return (
          <Pressable key={`fallback-${item.id}`} accessibilityRole="button" accessibilityLabel={t("settingsPanel.fallback.register", { leader: LEADER_LABEL, title: item.title })} style={on ? s.button : s.ghost} onPress={() => void onSetFallback(on ? "" : item.id)}>
            <Text style={on ? s.buttonText : s.ghostText}>{item.title} · {item.id.slice(0, 8)}</Text>
          </Pressable>
        );
      })}
      {data.concurrency ? (
        <Text style={s.muted}>
          {t("settingsPanel.concurrency", {
            global: data.concurrency.global,
            pools: Object.entries(data.concurrency.pools).map(([name, limit]) => `${name} ${limit}`).join(t("common.listSep")),
            roles: Object.entries(data.concurrency.roles).map(([name, limit]) => `${roleLabel(name)} ${limit}`).join(t("common.listSep")),
          })}
        </Text>
      ) : null}
      <Text style={s.muted}>{t("settingsPanel.poolSnapshot", { message: data.poolMessage })}</Text>
    </View>
  );
}
