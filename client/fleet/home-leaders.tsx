import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { Pressable, Text, View } from "react-native";
import { type BoardSnapshot, supervisorShiftRpc } from "../../shared/fleet/board";
import { sortLeaderRows, unresponsiveCards } from "../../shared/fleet/leader-panel";
import { foldProxies, proxyLine, type ProxyLine } from "../../shared/fleet/leader-proxy";
import { DEFAULT_LEADER_THRESHOLDS } from "../../shared/fleet/leader-usage";
import { formatContextTokens } from "../../shared/fleet/supervisor-shift-format";
import { shiftTag, tagsFor } from "../../shared/fleet/leader-attention";
import {
  cancelOptimistic,
  clockMs,
  continueOptimistic,
  dismissProject,
  failedLocalJob,
  hasUnreadReply,
  leaderContextLine,
  leaderStatusLine,
  mergeShiftJobs,
  preferShiftJob,
  releaseDismissed,
  retryOptimistic,
  shiftArmId,
  shiftJobsKey,
  shiftTrackVisible,
  stampFinishedAt,
  startOptimistic,
  withLocalJob,
} from "../../shared/fleet/leader-shift-view";
import { t } from "../../shared/fleet/i18n";
import { isWritingCode, overDispatch, WEEK_ITEM_KEYS, weekItemCount, weekItemLabel, writingCodeNote, type WeekStats } from "../../shared/fleet/leader-week";
import { isPausedProject, pausedLabel } from "../../shared/fleet/paused";
import { DecisionMaintSwitch } from "./decisions";
import { LeaderDetails } from "./leader-details";
import { AttentionBlock, TagChip } from "./leader-attention";
import { DelegationReminderAction, LeaderQuickReply } from "./leader-reply";
import {
  consumeShiftOpen,
  disarmShiftOpen,
  armShiftOpen,
  jobsForHeadline,
  retryShiftAction,
  shiftBarSteps,
  shiftConfirmation,
  shiftHeadline,
  shiftStepIndex,
  type ShiftProgress,
} from "../../shared/fleet/supervisor-shift";
import { OpenLink, pressed, ResponsiveGrid, Section, StatusDot, type OpenAgent, type Styles } from "./ui";

type Row = BoardSnapshot["supervisorPanel"]["rows"][number];
type Detail = NonNullable<BoardSnapshot["supervisorPanel"]["details"]>[number] | undefined;
type JobMap = Record<string, ShiftProgress>;

function useLeaderShift(data: BoardSnapshot, openAgent: OpenAgent, onShiftLine?: (line: string | null) => void) {
  const panel = data.supervisorPanel;
  const run = useRpc(supervisorShiftRpc);
  const queryClient = useQueryClient();
  const [ask, setAsk] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [local, setLocal] = useState<JobMap>({});
  const [pending, setPending] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [finishedAt, setFinishedAt] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const openRef = useRef(openAgent);
  openRef.current = openAgent;
  const jobFor = (project: string) => preferShiftJob(panel.tasks.find((job) => job.project === project), local[project]);
  const merged = mergeShiftJobs(panel.rows.map((row) => row.project), panel.tasks, local);
  const headline = shiftHeadline(jobsForHeadline(merged, dismissed));
  const shiftKey = shiftJobsKey(merged);
  useShiftEffects(panel.tasks, merged, shiftKey, headline, onShiftLine, openRef, setFinishedAt, setDismissed, setNow);
  const send = bindShiftSend(run, queryClient, openRef, jobFor, setLocal, setPending, setAsk);
  return { ask, setAsk, preview, setPreview, pending, dismissed, setDismissed, finishedAt, now, jobFor, send };
}

type ShiftModel = ReturnType<typeof useLeaderShift>;

function useShiftEffects(
  tasks: BoardSnapshot["supervisorPanel"]["tasks"],
  merged: ShiftProgress[],
  shiftKey: string,
  headline: string | null,
  onShiftLine: ((line: string | null) => void) | undefined,
  openRef: MutableRefObject<OpenAgent>,
  setFinishedAt: Dispatch<SetStateAction<Record<string, number>>>,
  setDismissed: Dispatch<SetStateAction<ReadonlySet<string>>>,
  setNow: Dispatch<SetStateAction<number>>,
) {
  useEffect(() => {
    for (const job of tasks) {
      const id = consumeShiftOpen(job.project, job);
      if (id) openRef.current?.(id);
    }
  }, [tasks, openRef]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [setNow]);
  useEffect(() => {
    setFinishedAt((prev) => stampFinishedAt(prev, merged, Date.now()));
    setDismissed((prev) => releaseDismissed(prev, merged));
    // shiftKey already names the phase of every merged job, so the lists above are the ones just rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftKey]);
  useEffect(() => { onShiftLine?.(headline); }, [headline, onShiftLine]);
}

function bindShiftSend(
  run: (input: { project: string; action: "start" | "continue" | "cancel" }) => Promise<{ job: ShiftProgress }>,
  queryClient: ReturnType<typeof useQueryClient>,
  openRef: MutableRefObject<OpenAgent>,
  jobFor: (project: string) => ShiftProgress | undefined,
  setLocal: Dispatch<SetStateAction<JobMap>>,
  setPending: (project: string | null) => void,
  setAsk: (project: string | null) => void,
) {
  return (project: string, action: "start" | "continue" | "cancel", optimistic?: ShiftProgress) => {
    setPending(project);
    setAsk(null);
    if (optimistic) setLocal((prev) => withLocalJob(prev, project, optimistic));
    const current = optimistic ?? jobFor(project);
    if (action !== "cancel") armShiftOpen(project, shiftArmId(current));
    run({ project, action })
      .then((result) => applyShiftResult(project, result.job, setLocal, openRef, queryClient))
      .catch((error: unknown) => {
        disarmShiftOpen(project);
        setLocal((prev) => withLocalJob(prev, project, failedLocalJob(current, project, error)));
      })
      .finally(() => setPending(null));
  };
}

function applyShiftResult(
  project: string,
  job: ShiftProgress,
  setLocal: Dispatch<SetStateAction<JobMap>>,
  openRef: MutableRefObject<OpenAgent>,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  setLocal((prev) => withLocalJob(prev, project, job));
  const id = consumeShiftOpen(project, job);
  if (id) openRef.current?.(id);
  void queryClient.invalidateQueries({ queryKey: ["afc", "snapshot"] });
}

export function LeaderBlock({ s, data, openAgent, onShiftLine }: {
  s: Styles;
  data: BoardSnapshot;
  openAgent: OpenAgent;
  onShiftLine?: (line: string | null) => void;
}) {
  const shift = useLeaderShift(data, openAgent, onShiftLine);
  const [help, setHelp] = useState(false);
  const nowMs = clockMs(data.generatedAt, shift.now);
  const panel = data.supervisorPanel;
  const folded = foldProxies(panel.rows.filter((row) => !isPausedProject(row.project, data.pausedProjects)), panel.details ?? [], data.decisions);
  const rows = sortLeaderRows(folded.rows, folded.details, folded.decisions, nowMs);
  const view: BoardSnapshot = { ...data, decisions: folded.decisions, supervisorPanel: { ...panel, details: folded.details } };
  return (
    <Section s={s} title={"<leader>"} extra={<HelpToggle s={s} open={help} onPress={() => setHelp((value) => !value)} />}>
      <Text style={s.muted}>{t("leader.usage.thresholds", { reminder: formatContextTokens(panel.thresholds?.reminderTokens ?? DEFAULT_LEADER_THRESHOLDS.reminderTokens), warning: formatContextTokens(panel.thresholds?.warningTokens ?? DEFAULT_LEADER_THRESHOLDS.warningTokens) })}</Text>
      {help ? <LeaderHelp s={s} data={data} /> : null}
      <AttentionBlock s={s} data={data} nowMs={nowMs} openAgent={openAgent} />
      {data.supervisorPanel.rows.length === 0 ? <Text style={s.muted}>{t("leader.ui.noRegistry")}</Text> : null}
      <ResponsiveGrid s={s}>
        {rows.map((row) => <LeaderCard key={row.project} s={s} row={row} data={view} proxies={folded.proxies.get(row.project)} nowMs={nowMs} openAgent={openAgent} shift={shift} />)}
      </ResponsiveGrid>
      {(data.pausedProjects ?? []).map((paused) => <PausedRow key={paused.project} s={s} data={data} paused={paused} openAgent={openAgent} />)}
    </Section>
  );
}

function HelpToggle({ s, open, onPress }: { s: Styles; open: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={open ? t("leader.help.hideA11y") : t("leader.help.showA11y")} style={pressed(s.ghost)} onPress={onPress}>
      <Text style={s.ghostText}>{open ? t("leader.help.hideA11y") : t("leader.help.show")}</Text>
    </Pressable>
  );
}

function LeaderHelp({ s, data }: { s: Styles; data: BoardSnapshot }) {
  return (
    <View style={[s.card, { gap: 8 }]}>
      <Text style={s.muted}>{t("leader.help.top")}</Text>
      <Text style={s.muted}>{t("leader.help.order")}</Text>
      <Text style={s.muted}>{t("leader.help.lamp")}</Text>
      <Text style={s.muted}>{t("leader.help.reply")}</Text>
      <DecisionMaintSwitch s={s} enabled={data.decisionMaint.enabled} />
    </View>
  );
}

function LeaderCard({ s, row, data, proxies, nowMs, openAgent, shift }: {
  s: Styles; row: Row; data: BoardSnapshot; proxies: ProxyLine[] | undefined; nowMs: number; openAgent: OpenAgent; shift: ShiftModel;
}) {
  const [open, setOpen] = useState(false);
  const detail = data.supervisorPanel.details?.find((item) => item.project === row.project);
  const job = shift.jobFor(row.project);
  const showTrack = shiftTrackVisible(job, shift.finishedAt[row.project] ?? null, shift.now);
  const dismiss = () => shift.setDismissed((prev) => dismissProject(prev, row.project));
  const retry = () => retryRow(job, row, dismiss, shift);
  const tags = tagsFor(row.project, detail, data.decisions, nowMs, { unread: hasUnreadReply(data.decisions, row.agentId), shift: shiftTag(job, showTrack) });
  return (
    <View style={[s.card, { gap: 8 }]}>
      <CompactHeader s={s} row={row} detail={detail} proxies={proxies} nowMs={nowMs} open={open} onToggle={() => setOpen((value) => !value)} />
      {tags.length > 0 ? <View style={s.row}>{tags.map((tag) => <TagChip key={tag.key} s={s} tag={tag} />)}</View> : null}
      <LeaderQuickReply s={s} project={row.project} cards={detail?.cards ?? []} unresponsive={unresponsiveCards(detail).length > 0} />
      {open ? <ExpandedBody s={s} row={row} detail={detail} data={data} openAgent={openAgent} job={job} showTrack={showTrack} shift={shift} dismiss={dismiss} retry={retry} /> : null}
    </View>
  );
}

/** A single unbroken project name must wrap instead of pushing the card wider than its column. */
const BREAK_LONG = { wordBreak: "break-word" } as object;

function CompactHeader({ s, row, detail, proxies, nowMs, open, onToggle }: {
  s: Styles; row: Row; detail: Detail; proxies: ProxyLine[] | undefined; nowMs: number; open: boolean; onToggle: () => void;
}) {
  const color = row.lamp === "red" ? s.p.red : row.lamp === "yellow" ? s.p.amber : row.lamp === "green" ? s.p.green : s.p.hint;
  return (
    <View style={[s.between, { flexWrap: "nowrap", alignItems: "flex-start" }]}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={[s.row, { flexWrap: "nowrap", minHeight: 44, alignItems: "center" }]}>
          <StatusDot color={color} />
          <Text style={[s.text, { fontWeight: "600", flexShrink: 1, minWidth: 0 }, BREAK_LONG]}>{row.code} · {row.project}</Text>
        </View>
        <Text style={s.muted}>{leaderStatusLine(row.statusText, detail?.lastReplyAt, nowMs)}</Text>
        {proxyLine(proxies) ? <Text style={[s.muted, BREAK_LONG]}>{proxyLine(proxies)}</Text> : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={t("leader.ui.detailsA11y", { action: open ? t("leader.ui.collapse") : t("leader.ui.expand"), code: row.code })} style={pressed(s.ghost)} onPress={onToggle}>
        <Text style={s.ghostText}>{open ? t("leader.ui.collapse") : t("leader.ui.expand")}</Text>
      </Pressable>
    </View>
  );
}

function ExpandedBody({ s, row, detail, data, openAgent, job, showTrack, shift, dismiss, retry }: {
  s: Styles; row: Row; detail: Detail; data: BoardSnapshot; openAgent: OpenAgent;
  job: ShiftProgress | undefined; showTrack: boolean; shift: ShiftModel; dismiss: () => void; retry: () => void;
}) {
  return (
    <View style={{ gap: 12, borderTopWidth: 1, borderTopColor: s.p.border, paddingTop: 12 }}>
      <LeaderDetails s={s} project={row.project} detail={detail} data={data} />
      <LeaderLamp s={s} row={row} />
      <Text style={s.muted}>{row.startedText}</Text>
      {row.todayText ? <Text style={s.muted}>{row.todayText}</Text> : null}
      <WeekLine s={s} stats={detail?.weekStats} />
      <View style={s.row}>
        <OpenLink s={s} agentId={row.agentId} openAgent={openAgent} label={t("leader.ui.openSession")} />
        <HandoverButton s={s} open={shift.preview === row.project} onPress={() => shift.setPreview((current) => (current === row.project ? null : row.project))} />
      </View>
      {shift.preview === row.project ? <HandoverPreview s={s} row={row} /> : null}
      <FailedShift s={s} job={job} />
      <LeaderShiftSlot s={s} row={row} job={job} showTrack={showTrack} shift={shift} dismiss={dismiss} retry={retry} />
      <DelegationReminderAction s={s} project={row.project} />
    </View>
  );
}

function retryRow(job: ShiftProgress | undefined, row: Row, dismiss: () => void, shift: ShiftModel) {
  if (!job) return;
  dismiss();
  const action = retryShiftAction(job);
  shift.send(row.project, action, retryOptimistic(row.project, row.code, action));
}

function LeaderShiftSlot({ s, row, job, showTrack, shift, dismiss, retry }: {
  s: Styles; row: Row; job: ShiftProgress | undefined; showTrack: boolean; shift: ShiftModel; dismiss: () => void; retry: () => void;
}) {
  if (showTrack && job) {
    return (
      <ShiftTrack
        s={s}
        job={job}
        pending={shift.pending === row.project}
        onCancel={() => { dismiss(); shift.send(row.project, "cancel", cancelOptimistic(job)); }}
        onContinue={() => shift.send(row.project, "continue", continueOptimistic(job))}
        onRetry={retry}
        onAgain={() => shift.setAsk(row.project)}
      />
    );
  }
  if (shift.ask === row.project) return <ShiftConfirm s={s} row={row} onSend={shift.send} onClose={() => shift.setAsk(null)} />;
  return <ShiftStart s={s} row={row} pending={shift.pending === row.project} onPress={() => shift.setAsk(row.project)} />;
}

function ShiftConfirm({ s, row, onSend, onClose }: {
  s: Styles; row: Row; onSend: ShiftModel["send"]; onClose: () => void;
}) {
  return (
    <View style={{ gap: 6, alignItems: "flex-end" }}>
      <Text style={s.text}>{shiftConfirmation(row.code, row.acceptanceCards)}</Text>
      <View style={s.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("shift.ui.confirmA11y", { code: row.code })} style={pressed(s.button)} onPress={() => onSend(row.project, "start", startOptimistic(row.project, row.code, row.statusText))}>
          <Text style={s.buttonText}>{t("shift.ui.confirm")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t("shift.ui.cancelA11y")} style={pressed(s.ghost)} onPress={onClose}>
          <Text style={s.ghostText}>{t("shift.ui.cancel")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ShiftStart({ s, row, pending, onPress }: { s: Styles; row: Row; pending: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("shift.ui.startA11y", { code: row.code })}
      disabled={pending}
      style={({ pressed: down }) => [row.highlight ? s.button : s.ghost, down || pending ? { opacity: 0.72 } : null]}
      onPress={onPress}
    >
      <Text style={row.highlight ? s.buttonText : s.ghostText}>{pending ? t("shift.ui.starting") : t("shift.ui.start")}</Text>
    </Pressable>
  );
}

function LeaderLamp({ s, row }: { s: Styles; row: Row }) {
  const color = row.lamp === "red" ? s.p.red : row.lamp === "yellow" ? s.p.amber : row.lamp === "green" ? s.p.green : s.p.hint;
  return (
    <View style={s.row}>
      <StatusDot color={color} />
      <Text style={[s.text, { fontVariant: ["tabular-nums"] }]}>{leaderContextLine(row)}</Text>
    </View>
  );
}

function HandoverButton({ s, open, onPress }: { s: Styles; open: boolean; onPress: () => void }) {
  return (
    <View style={s.row}>
      <Pressable accessibilityRole="button" accessibilityLabel={open ? t("shift.ui.hideHandover") : t("shift.ui.showHandover")} style={pressed(s.ghost)} onPress={onPress}>
        <Text style={s.ghostText}>{open ? t("shift.ui.hideHandover") : t("shift.ui.showHandover")}</Text>
      </Pressable>
    </View>
  );
}

function FailedShift({ s, job }: { s: Styles; job: ShiftProgress | undefined }) {
  if (!job || job.phase !== "failed" || job.canContinue) return null;
  return <Text style={[s.text, { color: s.p.red }]}>{t("shift.ui.failedLine", { label: job.label, detail: job.detail })}</Text>;
}

function HandoverPreview({ s, row }: { s: Styles; row: Row }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.muted}>{row.handoverPath ?? t("shift.ui.noHandoverFile")}</Text>
      {row.handoverPreview ? <Text style={s.muted}>{row.handoverPreview}</Text> : null}
    </View>
  );
}

/** One line at the bottom; opens to the usual details but never counts anywhere. */
function PausedRow({ s, data, paused, openAgent }: {
  s: Styles; data: BoardSnapshot; paused: NonNullable<BoardSnapshot["pausedProjects"]>[number]; openAgent: OpenAgent;
}) {
  const [open, setOpen] = useState(false);
  const row = data.supervisorPanel.rows.find((item) => isPausedProject(item.project, [paused]));
  const detail = data.supervisorPanel.details?.find((item) => isPausedProject(item.project, [paused]));
  const shown = { ...data, decisions: [...data.decisions, ...paused.decisions] };
  return (
    <View style={[s.card, { gap: 8, opacity: 0.8 }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={t("leader.ui.sectionA11y", { action: open ? t("leader.ui.collapse") : t("leader.ui.expand"), title: pausedLabel(paused) })} style={pressed([s.between, { minHeight: 44 }])} onPress={() => setOpen((value) => !value)}>
        <Text style={[s.muted, { flexShrink: 1 }]}>{pausedLabel(paused)}</Text>
        <Text style={s.muted}>{open ? t("leader.ui.collapse") : t("leader.ui.expand")}</Text>
      </Pressable>
      {open ? <PausedBody s={s} paused={paused} row={row} detail={detail} data={shown} openAgent={openAgent} /> : null}
    </View>
  );
}

function PausedBody({ s, paused, row, detail, data, openAgent }: {
  s: Styles;
  paused: NonNullable<BoardSnapshot["pausedProjects"]>[number];
  row: Row | undefined;
  detail: Detail;
  data: BoardSnapshot;
  openAgent: OpenAgent;
}) {
  return (
    <View style={{ gap: 8 }}>
      {paused.note ? <Text style={s.muted}>{paused.note}</Text> : null}
      {row ? <OpenLink s={s} agentId={row.agentId} openAgent={openAgent} label={t("leader.ui.openSession")} /> : null}
      <LeaderDetails s={s} project={row?.project ?? paused.project} detail={detail} data={data} paused />
    </View>
  );
}

/** Exported so the real-mount test can render it. Code commits only; doc commits are shown apart and never flagged. */
export function WeekLine({ s, stats }: { s: Styles; stats: WeekStats | null | undefined }) {
  if (stats === undefined) return <Text style={s.muted}>{t("leader.week.counting")}</Text>;
  if (stats === null) return <Text style={s.muted}>{t("leader.week.uncountable")}</Text>;
  const writingCode = isWritingCode(stats);
  return (
    <Text style={s.muted}>
      {t("leader.week.dispatched", { count: stats.dispatch })}
      {WEEK_ITEM_KEYS.map((key) => <Text key={key} style={key === "commit" && writingCode ? s.red : overDispatch(stats, key) ? s.yellow : s.muted}>{` · ${weekItemLabel(key)} ${weekItemCount(stats, key)}`}</Text>)}
      {` · ${t("leader.week.docCommits", { count: stats.docCommit })}`}
      {writingCode ? <Text style={s.red}>{` · ${writingCodeNote()}`}</Text> : null}
    </Text>
  );
}

function shiftTone(s: Styles, job: ShiftProgress): string {
  if (job.phase === "failed") return s.p.red;
  if (job.phase === "done") return s.p.green;
  return s.p.text;
}

function ShiftTrack({ s, job, pending, onCancel, onContinue, onRetry, onAgain }: {
  s: Styles; job: ShiftProgress; pending: boolean; onCancel: () => void; onContinue: () => void; onRetry: () => void; onAgain: () => void;
}) {
  const failed = job.phase === "failed";
  const tone = shiftTone(s, job);
  return (
    <View style={{ gap: 6, alignItems: "flex-end", maxWidth: 280, flexShrink: 1 }}>
      <ShiftBars s={s} failed={failed} index={shiftStepIndex(job.phase)} tone={tone} />
      <Text style={[s.text, { color: tone, fontWeight: "600" }]}>{job.label}</Text>
      <Text style={[s.text, failed ? { color: s.p.red } : null]}>{job.detail}</Text>
      <ShiftButtons s={s} job={job} pending={pending} failed={failed} onCancel={onCancel} onContinue={onContinue} onRetry={onRetry} onAgain={onAgain} />
    </View>
  );
}

function ShiftBars({ s, failed, index, tone }: { s: Styles; failed: boolean; index: number; tone: string }) {
  return (
    <View style={{ flexDirection: "row", gap: 4, width: 168 }} accessibilityRole="progressbar">
      {shiftBarSteps().map((label, step) => (
        <View key={label} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: failed ? s.p.red : index >= step ? tone : s.p.track }} />
      ))}
    </View>
  );
}

function ShiftButtons({ s, job, pending, failed, onCancel, onContinue, onRetry, onAgain }: {
  s: Styles; job: ShiftProgress; pending: boolean; failed: boolean; onCancel: () => void; onContinue: () => void; onRetry: () => void; onAgain: () => void;
}) {
  return (
    <View style={s.row}>
      {failed && job.canContinue ? <Pressable accessibilityRole="button" accessibilityLabel={t("shift.ui.retryA11y")} disabled={pending} style={pressed(s.button)} onPress={onRetry}><Text style={s.buttonText}>{t("shift.ui.retry")}</Text></Pressable> : null}
      {!failed && job.canContinue ? <Pressable accessibilityRole="button" accessibilityLabel={t("shift.ui.continueA11y")} disabled={pending} style={pressed(s.button)} onPress={onContinue}><Text style={s.buttonText}>{t("shift.button.continue")}</Text></Pressable> : null}
      {job.canCancel ? <Pressable accessibilityRole="button" accessibilityLabel={t("shift.ui.cancelQueueA11y")} disabled={pending} style={pressed(s.ghost)} onPress={onCancel}><Text style={s.ghostText}>{t("shift.ui.cancel")}</Text></Pressable> : null}
      {job.phase === "done" ? <Pressable accessibilityRole="button" accessibilityLabel={t("shift.ui.againA11y")} style={pressed(s.ghost)} onPress={onAgain}><Text style={s.ghostText}>{t("shift.ui.start")}</Text></Pressable> : null}
    </View>
  );
}
