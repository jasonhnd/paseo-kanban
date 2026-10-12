import { type ReactNode, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { PanelTab } from "../../shared/fleet/panel-tabs";

const WARM_STEP_MS = 60;

/**
 * Tabs that were opened (or pre-warmed) stay mounted and are only hidden, so a later click is a
 * style flip instead of a full mount. While hidden a pane keeps its last children, so the 10 s
 * snapshot refresh does not re-render panes nobody is looking at.
 */
export function TabPane({ active, children }: { active: boolean; children: ReactNode }) {
  const shown = useRef(children);
  if (active) shown.current = children;
  return <View style={active ? undefined : HIDDEN}>{shown.current}</View>;
}

const HIDDEN = { display: "none" as const };

/** Tabs to keep mounted: the active one now, the rest one per timer tick once `ready`, so a click never has to mount. */
export function useMountedTabs(active: PanelTab, order: readonly PanelTab[], ready: boolean): ReadonlySet<PanelTab> {
  const [warm, setWarm] = useState<readonly PanelTab[]>([]);
  // Every tab that has been active stays mounted, including the landing tab the moment it is left.
  const visited = useRef<ReadonlySet<PanelTab>>(new Set());
  if (!visited.current.has(active)) visited.current = new Set([...visited.current, active]);
  useEffect(() => {
    if (!ready) return;
    const next = order.find((id) => !visited.current.has(id) && !warm.includes(id));
    if (!next) return;
    const timer = setTimeout(() => setWarm((current) => (current.includes(next) ? current : [...current, next])), WARM_STEP_MS);
    return () => clearTimeout(timer);
  }, [ready, active, order, warm]);
  return new Set<PanelTab>([...visited.current, ...warm]);
}
