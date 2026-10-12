import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { PANEL_TABS, type PanelTab, type panelTabBadges } from "../../shared/fleet/panel-tabs";
import { t } from "../../shared/fleet/i18n";
import { tabScrollOffset } from "../../shared/fleet/responsive";
import { Badge, pressed, type Styles } from "./ui";

export function PanelTabs({ s, tab, badges, onChange }: { s: Styles; tab: PanelTab; badges: ReturnType<typeof panelTabBadges>; onChange: (tab: PanelTab) => void }) {
  const scroll = useRef<ScrollView>(null);
  const offset = useRef(0);
  const [viewport, setViewport] = useState(0);
  const [positions, setPositions] = useState<Partial<Record<PanelTab, { x: number; width: number }>>>({});
  useEffect(() => {
    const item = positions[tab];
    if (!s.compact || !item || viewport <= 0) return;
    const x = tabScrollOffset(item.x, item.width, viewport, offset.current);
    scroll.current?.scrollTo({ x, animated: false });
    offset.current = x;
  }, [tab, positions, viewport, s.compact]);

  const tabs = (
    <View accessibilityRole="tablist" style={[s.tabBar, s.compact ? null : { width: "100%" }]}>
      {PANEL_TABS.map(({ id, label }) => (
        <Pressable
          key={id}
          accessibilityRole="tab"
          accessibilityLabel={t("tabs.a11y", { label, count: badges[id].count })}
          accessibilityState={{ selected: id === tab }}
          aria-selected={id === tab}
          onLayout={(event) => {
            const { x, width } = event.nativeEvent.layout;
            setPositions((current) => current[id]?.x === x && current[id]?.width === width ? current : { ...current, [id]: { x, width } });
          }}
          onPress={() => onChange(id)}
          style={pressed([id === tab ? s.tabActive : s.tab, s.compact ? { flexShrink: 0 } : { flex: 1, minWidth: 0 }])}
        >
          <View style={{ flexDirection: s.breakpoint === "tablet" ? "column" : "row", alignItems: "center", gap: 4 }}>
            <Text style={id === tab ? s.tabTextActive : s.tabText}>{label}</Text>
            <Badge s={s} label={String(badges[id].count)} tone={badges[id].danger ? "red" : id === tab ? "blue" : "neutral"} />
          </View>
        </Pressable>
      ))}
    </View>
  );
  return s.compact ? (
    <ScrollView
      ref={scroll}
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      onLayout={(event) => setViewport(event.nativeEvent.layout.width)}
      onScroll={(event) => { offset.current = event.nativeEvent.contentOffset.x; }}
      scrollEventThrottle={16}
      style={{ flexGrow: 0, minHeight: 44 }}
    >{tabs}</ScrollView>
  ) : tabs;
}
