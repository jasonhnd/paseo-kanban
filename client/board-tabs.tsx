import { Pressable, ScrollView, Text, View } from "react-native";
import { boardTabLabel, type TabBadge } from "../shared/board-view";
import { t } from "../shared/i18n";
import { BOARD_TABS, type BoardTab } from "../shared/panel-prefs";
import { Badge, pressed, type Styles } from "./ui";

/** Same shape as the AFC panel tabs: underline for the active tab, a count badge on each. `tab` and `badges` are null while the first read is under way. */
export function BoardTabs({ s, tab, tabs = BOARD_TABS, badges, onChange }: { s: Styles; tab: BoardTab | null; tabs?: readonly BoardTab[]; badges: Record<BoardTab, TabBadge> | null; onChange: (tab: BoardTab) => void }) {
  const bar = (
    <View accessibilityRole="tablist" style={s.tabBar}>
      {tabs.map((id) => {
        const on = id === tab;
        const badge = badges?.[id];
        const showCount = id !== "settings" && Boolean(badge);
        return (
          <Pressable
            key={id}
            accessibilityRole="tab"
            accessibilityLabel={showCount && badge ? t("boardTabs.a11y.count", { tab: boardTabLabel(id), count: badge.count }) : boardTabLabel(id)}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(id)}
            style={pressed(on ? s.boardTabActive : s.boardTab)}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={on ? s.tabTextActive : s.tabText}>{boardTabLabel(id)}</Text>
              {showCount && badge ? <Badge s={s} label={String(badge.count)} tone={badge.danger && badge.count > 0 ? "danger" : on ? "accent" : "neutral"} /> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, minHeight: 44 }}>
      {bar}
    </ScrollView>
  );
}
