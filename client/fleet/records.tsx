import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { type BoardInsights, type BoardSnapshot, sweepEnabledRpc } from "../../shared/fleet/board";
import { clipError } from "../../shared/fleet/clip-error";
import { t } from "../../shared/fleet/i18n";
import {
  baselinePrefix,
  changeClock,
  freshModels,
  handoffClock,
  handoffMove,
  kanbanCountSummary,
  providerList,
  recordsAttention,
  reversed,
  roleLabel,
  scheduleIsQuiet,
  scheduleLastLine,
  scheduleStatusLine,
  sortByRuns,
  sweepAlarm,
  sweepHeadline,
  sweepTitleLine,
  usedModels,
  waitingCountSummary,
} from "../../shared/fleet/records-view";
import type { PanelTab } from "../../shared/fleet/panel-tabs";
import { fmtZhTokens } from "../../shared/fleet/token-chart";
import { SupervisorDecisions } from "./decisions";
import { Empty, Fold, OpenLink, pressed, ResponsiveGrid, type OpenAgent, type Styles, timeAgo } from "./ui";
import { KanbanOverview, WaitingCards } from "./work";
import { kanbanInstalled } from "../../shared/fleet/kanban-presence";

export { recordsAttention };

export function Records({ s, data, insights, openAgent, onNavigate }: { s: Styles; data: BoardSnapshot; insights: BoardInsights | undefined; openAgent: OpenAgent; onNavigate: (tab: PanelTab) => void }) {
  return (
    <ResponsiveGrid s={s} cards>
      <OverturnFold s={s} data={data} />
      {kanbanInstalled(data.kanban) ? <KanbanFold s={s} data={data} /> : null}
      {kanbanInstalled(data.kanban) ? <WaitingFold s={s} data={data} openAgent={openAgent} /> : null}
      <ScheduleFold s={s} data={data} openAgent={openAgent} />
      <HandoffFold s={s} data={data} />
      <CursorFold s={s} data={data} />
      <ChangeFold s={s} data={data} />
      {kanbanInstalled(data.kanban) ? <SweepFold s={s} data={data} /> : null}
      <MergeFold s={s} insights={insights} />
      <ScoreFold s={s} insights={insights} />
      <FreshFold s={s} insights={insights} />
      <RolesLink s={s} onNavigate={onNavigate} />
    </ResponsiveGrid>
  );
}

function OverturnFold({ s, data }: { s: Styles; data: BoardSnapshot }) {
  return (
    <Fold s={s} title={t("records.overturn.title")} summary={t("records.overturn.summary", { count: data.supervisorDecisions.length })}>
      <SupervisorDecisions s={s} data={data} />
    </Fold>
  );
}

function KanbanFold({ s, data }: { s: Styles; data: BoardSnapshot }) {
  return (
    <Fold s={s} title={t("records.kanban.title")} summary={kanbanCountSummary(data.kanban.available, data.kanban.counts)}>
      <KanbanOverview s={s} data={data} />
    </Fold>
  );
}

function WaitingFold({ s, data, openAgent }: { s: Styles; data: BoardSnapshot; openAgent: OpenAgent }) {
  return (
    <Fold s={s} title={t("records.waiting.title")} summary={waitingCountSummary(data.kanban.queueShown, data.kanban.waiting.length)}>
      <WaitingCards s={s} data={data} openAgent={openAgent} />
    </Fold>
  );
}

function ScheduleFold({ s, data, openAgent }: { s: Styles; data: BoardSnapshot; openAgent: OpenAgent }) {
  return (
    <Fold s={s} title={t("records.schedule.title")} summary={t("records.count", { count: data.schedules.length })}>
      {data.schedules.length === 0 ? <Empty s={s} text={t("records.schedule.empty")} /> : null}
      {data.schedules.map((row) => <ScheduleRow key={row.id} s={s} row={row} openAgent={openAgent} />)}
    </Fold>
  );
}

function ScheduleRow({ s, row, openAgent }: { s: Styles; row: BoardSnapshot["schedules"][number]; openAgent: OpenAgent }) {
  const last = scheduleLastLine(row, timeAgo(row.lastRunAt));
  return (
    <View style={[s.between, s.item]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.text}>{row.name || row.id}</Text>
        <Text style={scheduleIsQuiet(row) ? s.muted : s.yellow}>{scheduleStatusLine(row, timeAgo(row.nextRunAt))}</Text>
        {last ? <Text style={row.lastResult === "succeeded" ? s.muted : s.red} numberOfLines={2}>{last}</Text> : null}
      </View>
      <OpenLink s={s} agentId={row.ownerId} openAgent={openAgent} />
    </View>
  );
}

function HandoffFold({ s, data }: { s: Styles; data: BoardSnapshot }) {
  const rows = data.supervisorPanel.handoffs;
  return (
    <Fold s={s} title={t("records.handoff.title")} summary={t("records.recentCount", { count: rows.length })}>
      {rows.length === 0 ? <Empty s={s} text={t("records.handoff.empty")} /> : null}
      {rows.map((line) => <HandoffRow key={`${line.at}-${line.project}-${line.oldId}`} s={s} line={line} />)}
    </Fold>
  );
}

function HandoffRow({ s, line }: { s: Styles; line: BoardSnapshot["supervisorPanel"]["handoffs"][number] }) {
  const tokens = line.contextTokens === null ? null : fmtZhTokens(line.contextTokens);
  return (
    <View style={s.item}>
      <Text style={s.text}>{handoffClock(line.at)} · {line.project}</Text>
      <Text style={s.muted}>{handoffMove(line, tokens)}</Text>
    </View>
  );
}

function CursorFold({ s, data }: { s: Styles; data: BoardSnapshot }) {
  const notes = reversed(data.cursorNotes);
  return (
    <Fold s={s} title={t("records.cursor.title")} summary={t("records.count", { count: data.cursorNotes.length })}>
      {notes.length === 0 ? <Empty s={s} text={t("records.cursor.empty")} /> : null}
      {notes.map((note) => (
        <View key={`${note.at}-${note.text}`} style={s.item}>
          <Text style={s.text}>{note.text}</Text>
          <Text style={s.muted}>{handoffClock(note.at)}</Text>
        </View>
      ))}
    </Fold>
  );
}

function ChangeFold({ s, data }: { s: Styles; data: BoardSnapshot }) {
  return (
    <Fold s={s} title={t("records.change.title")} summary={t("records.count", { count: data.changes.length })}>
      {data.changes.length === 0 ? <Empty s={s} text={t("records.change.empty")} /> : null}
      {data.changes.map((change) => <ChangeRow key={`${change.at}-${change.role}`} s={s} change={change} roles={data.roles} />)}
    </Fold>
  );
}

function ChangeRow({ s, change, roles }: { s: Styles; change: BoardSnapshot["changes"][number]; roles: BoardSnapshot["roles"] }) {
  const known = roles.find((role) => role.key === change.role)?.name;
  return (
    <View style={s.item}>
      <Text style={s.text}>{changeClock(change.at)} · {roleLabel(change.role, known)}</Text>
      <Text style={s.muted}>{change.from}</Text>
      <Text style={s.muted}>→ {change.to}</Text>
    </View>
  );
}

function SweepFold({ s, data }: { s: Styles; data: BoardSnapshot }) {
  return (
    <Fold s={s} title={t("records.sweep.title")} summary={t("records.sweep.summary", { count: data.sweep.entries.length, state: t(data.sweep.enabled ? "records.on" : "records.off") })}>
      <SweepBody s={s} data={data} />
    </Fold>
  );
}

function SweepBody({ s, data }: { s: Styles; data: BoardSnapshot }) {
  const setEnabled = useRpc(sweepEnabledRpc);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = data.sweep.enabled;
  const toggle = () => toggleSweep(enabled, setEnabled, client, setBusy, setError);
  return (
    <View style={{ gap: 8 }}>
      <SweepSwitch s={s} enabled={enabled} busy={busy} onPress={toggle} />
      <Text style={s.muted}>{t("records.sweep.rule")}</Text>
      {error ? <Text style={s.red}>{error}</Text> : null}
      {data.sweep.entries.length === 0 ? <Empty s={s} text={t("records.sweep.empty")} /> : null}
      {data.sweep.entries.map((entry, index) => <SweepRow key={`${entry.at}-${entry.agentId ?? "round"}-${index}`} s={s} entry={entry} />)}
    </View>
  );
}

function toggleSweep(
  enabled: boolean,
  setEnabled: (input: { enabled: boolean }) => Promise<unknown>,
  client: ReturnType<typeof useQueryClient>,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
) {
  setBusy(true);
  setError(null);
  setEnabled({ enabled: !enabled })
    .then(() => client.invalidateQueries({ queryKey: ["afc", "snapshot"] }))
    .catch((error: unknown) => setError(clipError(error, 160)))
    .finally(() => setBusy(false));
}

function SweepSwitch({ s, enabled, busy, onPress }: { s: Styles; enabled: boolean; busy: boolean; onPress: () => void }) {
  const label = t(enabled ? "records.sweep.onLabel" : "records.sweep.offLabel");
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={t(enabled ? "records.sweep.turnOff" : "records.sweep.turnOn")} accessibilityState={{ checked: enabled }} disabled={busy} style={pressed([s.ghost, { alignSelf: "flex-start" }])} onPress={onPress}>
      <Text style={enabled ? s.green : s.muted}>{t(enabled ? "records.on" : "records.off")} · {label}</Text>
    </Pressable>
  );
}

function SweepRow({ s, entry }: { s: Styles; entry: BoardSnapshot["sweep"]["entries"][number] }) {
  const title = sweepTitleLine(entry.title, entry.agentId);
  return (
    <View style={s.item}>
      <Text style={sweepAlarm(entry.result) ? s.red : s.text}>{sweepHeadline(entry)}</Text>
      {title ? <Text style={s.text}>{title}</Text> : null}
      {entry.cwd ? <Text style={s.muted}>{entry.cwd}</Text> : null}
      {entry.reason ? <Text style={s.muted}>{entry.reason}</Text> : null}
    </View>
  );
}

function MergeFold({ s, insights }: { s: Styles; insights: BoardInsights | undefined }) {
  return (
    <Fold s={s} title={t("records.merge.title")} summary={insights ? t("records.count", { count: insights.unreviewedMerges.length }) : t("records.loadingShort")}>
      {!insights ? <Empty s={s} text={t("records.merge.loading")} /> : null}
      {insights && insights.unreviewedMerges.length === 0 ? <Text style={s.green}>{t("records.merge.allReviewed")}</Text> : null}
      {insights?.unreviewedMerges.map((pr) => <MergeRow key={`${pr.repo}#${pr.number}`} s={s} pr={pr} />)}
      {insights ? <Text style={s.muted}>{t("records.merge.note")}</Text> : null}
    </Fold>
  );
}

function MergeRow({ s, pr }: { s: Styles; pr: BoardInsights["unreviewedMerges"][number] }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={t("records.merge.open", { number: pr.number })} style={s.item} onPress={() => Linking.openURL(pr.url)}>
      <Text style={s.yellow}>{pr.repo} #{pr.number} · {pr.author} · {t("records.merge.mergedAt", { ago: timeAgo(pr.mergedAt) })}</Text>
      <Text style={s.text} numberOfLines={2}>{pr.title}</Text>
    </Pressable>
  );
}

function ScoreFold({ s, insights }: { s: Styles; insights: BoardInsights | undefined }) {
  const score = sortByRuns(insights?.scorecard ?? []);
  return (
    <Fold s={s} title={t("records.score.title")} summary={insights ? t("records.count", { count: score.length }) : t("records.loadingShort")}>
      {!insights ? <Empty s={s} text={t("records.score.loading")} /> : null}
      {insights && score.length === 0 ? <Empty s={s} text={t("records.score.empty")} /> : null}
      <ResponsiveGrid s={s}>{score.map((row) => <ScoreCard key={`${row.role}|${row.model}`} s={s} row={row} />)}</ResponsiveGrid>
      {insights ? <Text style={s.muted}>{t("records.score.note")}</Text> : null}
    </Fold>
  );
}

function ScoreCard({ s, row }: { s: Styles; row: BoardInsights["scorecard"][number] }) {
  return (
    <View style={s.card}>
      <Text style={s.h2}>{roleLabel(row.role)}</Text>
      <Text style={s.text}>{row.model}</Text>
      <Text style={s.muted}>{t("records.score.runs", { runs: row.runs, minutes: row.avgMinutes ?? "?", followUps: row.followUps })}</Text>
      <Text style={row.errors ? s.red : s.muted}>{t("records.score.errors", { count: row.errors })}</Text>
      <Text style={row.interrupted ? s.yellow : s.muted}>{t("records.score.interrupted", { count: row.interrupted })}</Text>
      {row.role === "reviewer" ? <Text style={s.text}>{t("records.score.reviews", { approved: row.reviewsApproved, changes: row.reviewsChanges })}</Text> : null}
    </View>
  );
}

function FreshFold({ s, insights }: { s: Styles; insights: BoardInsights | undefined }) {
  const fresh = freshModels(insights?.models ?? []);
  return (
    <Fold s={s} title={t("records.fresh.title")} summary={insights ? t("records.count", { count: fresh.length }) : t("records.loadingShort")}>
      {!insights ? <Empty s={s} text={t("records.fresh.loading")} /> : null}
      {insights && fresh.length === 0 ? <Empty s={s} text={t("records.fresh.empty")} /> : null}
      {fresh.map((model) => <FreshRow key={`${model.provider}/${model.id}`} s={s} model={model} />)}
      {insights ? <ModelFootnote s={s} insights={insights} /> : null}
    </Fold>
  );
}

function FreshRow({ s, model }: { s: Styles; model: BoardInsights["models"][number] }) {
  return (
    <View style={s.item}>
      <Text style={s.green}>🆕 {model.provider}/{model.id}</Text>
      <Text style={s.muted}>{t("records.fresh.firstSeen", { label: model.label, ago: timeAgo(model.firstSeen) })}</Text>
    </View>
  );
}

function ModelFootnote({ s, insights }: { s: Styles; insights: BoardInsights }) {
  return (
    <Text style={s.muted}>
      {baselinePrefix(insights.modelsBaselineAt)}
      {t("records.fresh.footnote", { count: insights.models.length, providers: providerList(insights.models), models: usedModels(insights.models) })}
    </Text>
  );
}

function RolesLink({ s, onNavigate }: { s: Styles; onNavigate: (tab: PanelTab) => void }) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={t("records.rolesLink.label")} style={pressed([s.ghost, { alignSelf: "flex-start" }])} onPress={() => onNavigate("roles")}>
      <Text style={s.ghostText}>{t("records.rolesLink.text")}</Text>
    </Pressable>
  );
}
