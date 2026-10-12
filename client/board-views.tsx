import { useState } from "react";
import { Pressable, Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { cardHint, type AttentionGroup, type AttentionItem, type SystemAlert } from "../shared/board-view";
import { t } from "../shared/i18n";
import { BOARD_COLUMNS, LEADER_LABEL } from "../shared/labels";
import type { DoctorRedView, ProjectRowView } from "../shared/rpc";
import { CompactCard, type CompactTask } from "./compact-card";
import { AlertLine, Badge, Button, COLUMN_MIN_WIDTH, Empty, elapsed, pressed, type Styles } from "./ui";

/** Cards shown per column before "show more"; a long Done list should not bury the board. */
export const COLUMN_PAGE = 30;

const COLUMN_GAP = 16;
const COLUMN_COUNT = BOARD_COLUMNS.length;
/** Page padding and column frame around the width the window reports, until the board measures itself. */
const FIRST_PAINT_INSET = 56;

/** True when three side-by-side columns would each be narrower than COLUMN_MIN_WIDTH. */
export function shouldStackColumns(containerWidth: number): boolean {
  return (containerWidth - COLUMN_GAP * (COLUMN_COUNT - 1)) / COLUMN_COUNT < COLUMN_MIN_WIDTH;
}

/** To Do / Doing / Done, each as a column of compact cards. Too narrow for three columns: one column under another. */
export function OverviewColumns({ s, tasks, onOpen, showProject }: { s: Styles; tasks: readonly CompactTask[]; onOpen: (id: number) => void; showProject: boolean }) {
  const [limits, setLimits] = useState<Record<string, number>>({});
  const viewport = useWindowDimensions();
  const [measured, setMeasured] = useState<number | null>(null);
  const stacked = shouldStackColumns(measured ?? viewport.width - FIRST_PAINT_INSET);
  const onLayout = (event: LayoutChangeEvent) => setMeasured(event.nativeEvent.layout.width);
  return (
    <View testID="board-columns" onLayout={onLayout} style={stacked ? s.columnsStacked : s.columns}>
      {BOARD_COLUMNS.map((column) => {
        const cards = tasks.filter((task) => task.column === column.id);
        const limit = limits[column.id] ?? COLUMN_PAGE;
        return (
          <View key={column.id} testID={`column-${column.id}`} style={stacked ? s.columnStacked : s.column}>
            <Text style={s.h2}>
              {column.label} <Text style={s.count}>{cards.length}</Text>
            </Text>
            {cards.length === 0 ? <Empty s={s} text={t("boardViews.column.empty")} /> : null}
            {cards.slice(0, limit).map((task) => (
              <CompactCard key={task.id} s={s} task={task} onOpen={onOpen} showProject={showProject} />
            ))}
            {cards.length > limit ? (
              <Button
                s={s}
                tone="secondary"
                label={t("boardViews.column.more", { count: Math.min(COLUMN_PAGE, cards.length - limit), left: cards.length - limit })}
                accessibilityLabel={t("boardViews.column.moreLabel", { column: column.label })}
                onPress={() => setLimits((current) => ({ ...current, [column.id]: limit + COLUMN_PAGE }))}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** Urgent cards listed before "show more". */
export const ATTENTION_PAGE = 50;

function DoctorGroup({ s, reds, onOpen }: { s: Styles; reds: readonly DoctorRedView[]; onOpen: (id: number) => void }) {
  return (
    <View testID="attention-doctor" style={{ gap: 8 }}>
      <Text style={s.h2}>
        {t("boardViews.doctor.title")} <Text style={s.count}>{reds.length}</Text>
      </Text>
      {reds.map((red) => {
        const body = (
          <>
            <View style={s.compactLine}>
              <Badge s={s} tone="danger" label={t("boardViews.doctor.danger")} dot />
              <Text numberOfLines={1} style={[s.cardTitle, { flex: 1, minWidth: 0 }]}>{red.card ?? red.object}</Text>
            </View>
            <Text style={s.secondary}>{red.symptom}</Text>
            {red.suggestion ? <Text selectable style={s.mono}>{red.suggestion}</Text> : null}
          </>
        );
        if (red.taskId === null) return <View key={red.id} testID="doctor-red" style={s.compactCard}>{body}</View>;
        const taskId = red.taskId;
        return (
          <Pressable key={red.id} testID="doctor-red" accessibilityRole="button" accessibilityLabel={t("boardViews.doctor.open", { card: red.card ?? taskId })} onPress={() => onOpen(taskId)} style={pressed(s.compactCard)}>
            {body}
          </Pressable>
        );
      })}
    </View>
  );
}

function QuietGroup({ s, items, onOpen }: { s: Styles; items: readonly AttentionItem<CompactTask>[]; onOpen: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <View testID="attention-quiet" style={{ gap: 8 }}>
      <Button s={s} tone="secondary" label={t("boardViews.quiet.toggle", { action: open ? t("cardDrawer.timeline.collapse") : t("boardViews.quiet.expand"), count: items.length })} accessibilityLabel={t("boardViews.quiet.label", { count: items.length })} onPress={() => setOpen((on) => !on)} />
      {open ? items.map((item) => <CompactCard key={item.task.id} s={s} task={item.task} onOpen={onOpen} showProject note={cardHint(item.task) ?? { tone: "warning", text: item.reason }} />) : null}
    </View>
  );
}

/** Cards that need a person, by project, most urgent first. Slow waits fold into one closed group. */
export function AttentionView({ s, groups, quiet = [], doctorReds = [], alerts, onOpen, memo }: {
  s: Styles;
  groups: readonly AttentionGroup<CompactTask>[];
  quiet?: readonly AttentionItem<CompactTask>[];
  doctorReds?: readonly DoctorRedView[];
  alerts: readonly SystemAlert[];
  onOpen: (id: number) => void;
  memo: string | null;
}) {
  const [limit, setLimit] = useState(ATTENTION_PAGE);
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  let budget = limit;
  const shown = groups.flatMap((group) => {
    const items = group.items.slice(0, Math.max(0, budget));
    budget -= items.length;
    return items.length > 0 ? [{ ...group, items, total: group.items.length }] : [];
  });
  const nothing = total === 0 && quiet.length === 0 && doctorReds.length === 0 && alerts.length === 0;
  return (
    <View testID="attention-view" style={{ gap: 16 }}>
      {alerts.length > 0 ? (
        <View testID="system-alerts" style={{ gap: 6 }}>
          {alerts.map((alert) => <AlertLine key={alert.text} s={s} tone={alert.tone} text={alert.text} />)}
        </View>
      ) : null}
      {memo ? <Text style={s.muted}>{memo}</Text> : null}
      {nothing ? <Empty s={s} text={t("boardViews.attention.none")} /> : null}
      {shown.map((group) => (
        <View key={group.project} testID={`attention-${group.project}`} style={{ gap: 8 }}>
          <Text style={s.h2}>
            {group.project} <Text style={s.count}>{group.total}</Text>
          </Text>
          {group.items.map((item) => (
            <CompactCard
              key={item.task.id}
              s={s}
              task={item.task}
              onOpen={onOpen}
              note={cardHint(item.task) ?? { tone: item.rank <= 2 ? "danger" : "warning", text: item.reason }}
            />
          ))}
        </View>
      ))}
      {total > limit ? (
        <Button
          s={s}
          tone="secondary"
          label={t("boardViews.attention.more", { left: total - limit })}
          accessibilityLabel={t("boardViews.attention.moreLabel")}
          onPress={() => setLimit((current) => current + ATTENTION_PAGE)}
        />
      ) : null}
      {doctorReds.length > 0 ? <DoctorGroup s={s} reds={doctorReds} onOpen={onOpen} /> : null}
      {quiet.length > 0 ? <QuietGroup s={s} items={quiet} onOpen={onOpen} /> : null}
    </View>
  );
}

function ago(iso: string | null): string {
  return iso ? t("boardViews.ago", { elapsed: elapsed(iso) }) : t("boardViews.noAction");
}

/** One line per project. Pressing it filters the board to that project. */
export function ProjectsView({ s, rows, onPick }: { s: Styles; rows: readonly ProjectRowView[]; onPick: (project: string) => void }) {
  if (rows.length === 0) return <Empty s={s} text={t("boardViews.projects.none")} />;
  return (
    <View testID="projects-view" style={{ gap: 8 }}>
      {rows.map((row) => (
        <Pressable
          key={row.project}
          accessibilityRole="button"
          accessibilityLabel={t("boardViews.projects.pick", { project: row.project })}
          onPress={() => onPick(row.project)}
          style={pressed(s.compactCard)}
        >
          <View style={s.compactLine}>
            <Text numberOfLines={1} style={[s.cardTitle, { flex: 1, minWidth: 0 }]}>{row.project}</Text>
            {row.blocked > 0 ? <Badge s={s} tone="danger" label={t("boardViews.projects.blocked", { count: row.blocked })} dot /> : null}
            {row.acceptance > 0 ? <Badge s={s} tone="warning" label={t("boardViews.projects.acceptance", { count: row.acceptance })} dot /> : null}
          </View>
          <Text style={s.secondary}>{t("boardViews.projects.counts", { running: row.running, acceptance: row.acceptance, blocked: row.blocked, waiting: row.waiting })}</Text>
          <Text numberOfLines={1} style={s.muted}>
            {row.leaderAgentId
              ? t("boardViews.projects.leader", { leader: LEADER_LABEL, title: row.leaderTitle ?? row.leaderAgentId.slice(0, 8), ago: ago(row.lastLeaderActionAt) })
              : t("boardViews.projects.noLeader", { leader: LEADER_LABEL })}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
