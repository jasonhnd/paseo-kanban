import { useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { cardHint, type ViewTask } from "../shared/board-view";
import { t } from "../shared/i18n";
import { cardFaceTone, isLandPendingBadge, isWaitingParentsBadge } from "../shared/labels";
import { Badge, pressed, type Styles } from "./ui";

/** Finished cards use the success tone unless they still have to land; the rest follow the shared card tone. */
function compactTone(task: CompactTask): "danger" | "warning" | "success" {
  if (task.status === "done" && !isLandPendingBadge(task.badge) && !task.awaitingMerge) return "success";
  return cardFaceTone(task);
}

export type CompactTask = ViewTask & {
  roleLabel: string;
  returnNote: string | null;
  acceptanceMissing: boolean;
  awaitingMerge: boolean;
  /** Who sent it, e.g. `KBN <leader>`. */
  assignerShort?: string;
  /** Short model name, the profile name, or "not assigned". */
  modelShort?: string;
};

/** The badge as printed on the card: a wait on parents says only "waiting for parents"; the card numbers live in the hint and the drawer. */
export function badgeFace(badge: string): string {
  return isWaitingParentsBadge(badge) ? t("labels.badge.waitingParentsBare") : badge;
}

/** Reasons this short are never cut; longer ones keep the ellipsis. */
export const SHORT_REASON_CHARS = 6;

/** Line two of the face, in two segments: who sent it (may be cut short) and role · model (never cut). */
export function dispatchParts(task: Pick<CompactTask, "assignerShort" | "roleLabel" | "modelShort">): { who: string; roleModel: string } {
  return {
    who: t("compactCard.dispatch.who", { who: task.assignerShort || t("labels.assigner.unknown") }),
    roleModel: `${task.roleLabel} · ${task.modelShort || t("labels.model.unassigned")}`,
  };
}

/**
 * Two lines: number, title and status badge; then who sent it, to which role, on which model. The role · model segment
 * never shrinks (the project name and sender are cut first). The hint (blocked reason, quota wait, drag count) is
 * read aloud with the badge and lives in the detail drawer; only the attention list, which is about the reason a
 * card is there, shows it as a short visible tail on line two.
 */
export function CompactCard({ s, task, onOpen, note, showProject = false }: {
  s: Styles;
  task: CompactTask;
  onOpen: (id: number) => void;
  /** The reason a card is on the attention list. Shown as a short tail on line two; other lists pass none. */
  note?: { tone: "danger" | "warning" | "muted"; text: string } | null;
  showProject?: boolean;
}) {
  const hint = note ?? cardHint(task);
  const [width, setWidth] = useState<number | null>(null);
  // Roomy until measured. A card too narrow for number + 12 title characters + badge gives the title its own line.
  const extraBadge = Math.max(0, [...badgeFace(task.badge)].length - 4) * s.badgeChar;
  const roomy = width === null || width >= s.cardRoomy + extraBadge;
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  const shortReason = note ? [...note.text].length <= SHORT_REASON_CHARS : false;
  const badge = (
    <View testID="card-status" accessibilityLabel={hint ? `${task.badge}${t("common.colon")}${hint.text}` : task.badge} style={{ flexShrink: 1, minWidth: 0, maxWidth: "100%" }}>
      <Badge s={s} label={badgeFace(task.badge)} tone={compactTone(task)} dot fit />
    </View>
  );
  const title = <Text testID="card-title" numberOfLines={1} style={[s.cardTitle, { flex: 1, minWidth: 0 }]}>{task.title}</Text>;
  const { who, roleModel } = dispatchParts(task);
  const tail = note ? (note.tone === "danger" ? s.p.danger : note.tone === "warning" ? s.p.warning : s.p.textTertiary) : null;
  return (
    <Pressable
      testID="kanban-card"
      accessibilityRole="button"
      accessibilityLabel={t("compactCard.a11y.open", { code: task.code, title: task.title })}
      accessibilityHint={hint?.text}
      onPress={() => onOpen(task.id)}
      onLayout={onLayout}
      style={pressed(s.compactCard)}
    >
      {roomy ? (
        <View style={s.compactLine}>
          <Text style={[s.mono, { flexShrink: 0 }]}>{task.code}</Text>
          {title}
          {badge}
        </View>
      ) : (
        <>
          <View style={[s.compactLine, { justifyContent: "space-between" }]}>
            <Text style={[s.mono, { flexShrink: 0 }]}>{task.code}</Text>
            {badge}
          </View>
          <View style={s.compactLine}>{title}</View>
        </>
      )}
      <View testID="card-dispatch" style={[s.compactLine, { gap: 0 }]}>
        <Text testID="card-dispatch-who" numberOfLines={1} style={[s.muted, { flexShrink: 1, minWidth: 0 }]}>
          {showProject ? `${task.project} · ${who}` : who}
        </Text>
        <Text testID="card-dispatch-rolemodel" style={[s.muted, { flexShrink: 0 }]}>{` · ${roleModel}`}</Text>
        {note && tail ? (
          <Text testID="card-reason" numberOfLines={1} style={[s.muted, { color: tail, marginLeft: 8 }, shortReason ? { flexShrink: 0 } : { flexShrink: 1, minWidth: 0, maxWidth: "55%" }]}>{note.text}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}
