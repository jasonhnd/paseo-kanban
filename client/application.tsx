import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KanbanBoard } from "./board";
import { SettingsScreen } from "./settings/screen";
import { RoleBoard } from "./fleet/board";
import { FleetSettings } from "./fleet/settings";
import { paletteFromTheme } from "../shared/palette";
import { t } from "../shared/i18n";
import { useI18n } from "./i18n";
import { PANEL_TAB_IDS, panelTabLabel, type PanelTab } from "../shared/fleet/panel-tabs";

type Tab = "board" | PanelTab | "settings";
/** Keeps the public board screen/deep link and the workspace's project restriction. */
export function Application(props: PluginSurfaceProps & { lockedProject?: string | null }) {
  useI18n();
  const [tab, setTab] = useState<Tab>("board");
  const p = paletteFromTheme(props.theme);
  const tabs: Tab[] = ["board", ...PANEL_TAB_IDS, "settings"];
  return <View style={{ flex: 1, backgroundColor: p.bg }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12 }}>
      {tabs.map(id => <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: tab === id }}
        accessibilityLabel={id === "board" ? t("application.board") : id === "settings" ? t("settings.screen.title") : panelTabLabel(id)}
        onPress={() => setTab(id)} style={{ padding: 10, borderRadius: 8, backgroundColor: tab === id ? p.primaryBg : p.card }}>
        <Text style={{ color: tab === id ? p.primaryFg : p.text }}>{id === "board" ? t("application.board") : id === "settings" ? t("settings.screen.title") : panelTabLabel(id)}</Text>
      </Pressable>)}
    </View>
    {tab === "board" ? <KanbanBoard {...props} /> : tab === "settings" ? <ApplicationSettings {...props} /> :
      <RoleBoard {...props} tab={tab} onTabChange={setTab} integrated />}
  </View>;
}
export function ApplicationSettings(props: PluginSurfaceProps) {
  return <View style={{ flex: 1 }}><SettingsScreen {...props} /><FleetSettings {...props} integrated /></View>;
}
