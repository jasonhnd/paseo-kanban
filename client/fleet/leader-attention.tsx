import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type BoardSnapshot } from "../../shared/fleet/board";
import { splitRecentChoices } from "../../shared/fleet/decision-change";
import type { ChosenState } from "../../shared/fleet/decision-card";
import { t, type MessageKey } from "../../shared/fleet/i18n";
import { attentionEmpty, attentionItems, attentionTitle, type AttentionItem, type LeaderTag } from "../../shared/fleet/leader-attention";
import { elapsedLabel } from "../../shared/fleet/leader-panel";
import { isPausedProject } from "../../shared/fleet/paused";
import type { ReplyMessage } from "./decision-actions";
import { type Decision, DecisionCard } from "./decision-card";
import { usePanelClosedRows } from "./panel-closed-rows";
import { LeaderReplyBox, RemindAcceptance, SendNotice, useLeaderSend } from "./leader-reply";
import { Badge, Empty, type OpenAgent, pressed, toneColor, type Styles, type Tone } from "./ui";

const KIND_LABEL: Record<AttentionItem["kind"], { label: MessageKey; tone: Tone }> = {
  decision: { label: "leader.ui.blockingWork", tone: "red" },
  unresponsive: { label: "leader.kindLabel.unresponsive", tone: "red" },
  "stale-acceptance": { label: "leader.kindLabel.staleAcceptance", tone: "yellow" },
  question: { label: "leader.kindLabel.question", tone: "yellow" },
};

/** Chip for the compact card; same colours as the top list so a colour means one thing. */
export function TagChip({ s, tag }: { s: Styles; tag: LeaderTag }) {
  return <Badge s={s} label={tag.label} tone={tag.tone === "neutral" ? "neutral" : tag.tone} />;
}

interface KeptChoice { item: Extract<AttentionItem, { kind: "decision" }>; chosen: ChosenState }

/** Rows already answered stay on screen even after the snapshot drops them, so the user sees the result and can change it. */
function withKept(items: AttentionItem[], kept: ReadonlyMap<string, KeptChoice>): AttentionItem[] {
  const shown = new Set(items.map((item) => item.key));
  return [...items, ...[...kept.values()].map((entry) => entry.item).filter((item) => !shown.has(item.key))];
}

/** Answers from the last 24 hours, read back from the server, so reopening the panel still offers "change answer". */
function storedAttention(data: BoardSnapshot, rows: BoardSnapshot["supervisorPanel"]["rows"]): ReadonlyMap<string, KeptChoice> {
  const mine = splitRecentChoices(data.recentChoices ?? [], rows.map((row) => row.project), () => false).registered;
  return new Map(mine.flatMap((choice) => {
    const row = rows.find((candidate) => candidate.project.toLowerCase() === choice.project.toLowerCase());
    if (!row) return [];
    const decision = { id: choice.id, project: choice.project, title: choice.title, detail: choice.detail, blocking: choice.blocking, kind: "decide" as const, source: choice.source, createdAt: choice.createdAt, agentId: choice.agentId };
    const item = { kind: "decision" as const, key: `decision-${choice.id}`, project: choice.project, code: row.code, decision };
    return [[item.key, { item, chosen: { id: choice.id, letter: choice.letter, message: "", at: Date.parse(choice.doneAt) } }] as const];
  }));
}

/** This session's own picks win; a stored answer that a session change already replaced is dropped. */
function mergeStored(stored: ReadonlyMap<string, KeptChoice>, session: ReadonlyMap<string, KeptChoice>): ReadonlyMap<string, KeptChoice> {
  const answerIds = new Set([...session.values()].map((entry) => entry.chosen.id));
  return new Map([...[...stored].filter(([, entry]) => !answerIds.has(entry.chosen.id)), ...session]);
}

/** Everything that needs the user, across every <leader>: one line per item, most urgent first. */
export function AttentionBlock({ s, data, nowMs, openAgent = null }: { s: Styles; data: BoardSnapshot; nowMs: number; openAgent?: OpenAgent }) {
  const [session, setKept] = useState<ReadonlyMap<string, KeptChoice>>(new Map());
  const { held, note: noteClose } = usePanelClosedRows<Extract<AttentionItem, { kind: "decision" }>>(data);
  const rows = data.supervisorPanel.rows.filter((row) => !isPausedProject(row.project, data.pausedProjects));
  const kept = useMemo(() => mergeStored(storedAttention(data, rows), session), [data, rows, session]);
  const openItems = withKept(attentionItems(rows, data.supervisorPanel.details ?? [], data.decisions, nowMs), kept);
  const openKeys = new Set(openItems.map((item) => item.key));
  const extras = [...held.values()].filter((entry) => !openKeys.has(entry.row.key));
  const items = [...openItems, ...extras.map((entry) => entry.row)];
  const closedKeys = new Set([...held.values()].filter((entry) => entry.closed).map((entry) => entry.row.key));
  const activeCount = items.filter((item) => !closedKeys.has(item.key)).length;
  const note = (item: AttentionItem, message: ReplyMessage) => {
    if (item.kind === "decision" && message.chosen) setKept((prev) => new Map(prev).set(item.key, { item, chosen: message.chosen as ChosenState }));
    if (item.kind === "decision") noteClose(item.decision.id, item, message);
  };
  return (
    <View style={[s.card, { gap: 0 }]}>
      <Text style={[s.h2, { marginBottom: 4 }]}>{items.length > 0 ? t("leader.attention.headingCount", { count: activeCount }) : t("leader.attention.heading")}</Text>
      {items.length === 0 ? <Empty s={s} text={attentionEmpty()} /> : null}
      {items.map((item, index) => (
        <View key={item.key} style={[index > 0 ? { borderTopWidth: 1, borderTopColor: s.p.border } : null, { paddingVertical: 4, gap: 6 }]}>
          <AttentionRow s={s} item={item} data={data} nowMs={nowMs} openAgent={openAgent} chosen={kept.get(item.key)?.chosen ?? null} panelClosed={closedKeys.has(item.key)} onResult={(message) => note(item, message)} />
        </View>
      ))}
    </View>
  );
}

function AttentionRow({ s, item, data, nowMs, openAgent, chosen, panelClosed, onResult }: {
  s: Styles; item: AttentionItem; data: BoardSnapshot; nowMs: number; openAgent: OpenAgent; chosen: ChosenState | null; panelClosed: boolean; onResult: (message: ReplyMessage) => void;
}) {
  const kind = panelClosed ? { label: "leader.ui.handled" as MessageKey, tone: "neutral" as Tone } : KIND_LABEL[item.kind];
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState(false);
  const sender = useLeaderSend(item.project);
  const cards = data.supervisorPanel.details?.find((d) => d.project === item.project)?.cards ?? [];
  const urge = item.kind === "unresponsive" || item.kind === "stale-acceptance";
  const isDecision = item.kind === "decision";
  return (
    <>
      <View style={[s.row, { flexWrap: "nowrap" }]}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${open ? t("leader.ui.collapse") : t("leader.ui.expand")} ${attentionTitle(item)}`} style={pressed({ flex: 1, minWidth: 0, minHeight: 44, justifyContent: "center" })} onPress={() => setOpen((value) => !value)}>
          <Text numberOfLines={open ? undefined : 1} style={[s.text, { minWidth: 0 }]}>
            <Text style={{ color: toneColor(s, kind.tone), fontWeight: "600" }}>{t(kind.label)}  </Text>
            <Text style={{ fontWeight: "600" }}>{attentionTitle(item)}</Text>
          </Text>
        </Pressable>
        {isDecision ? <DecideToggle s={s} code={item.code} open={open} chosen={chosen !== null} panelClosed={panelClosed} onPress={() => setOpen((value) => !value)} /> : null}
        {urge ? <RemindAcceptance s={s} cards={cards} sender={sender} strong /> : null}
        {!isDecision ? <ReplyToggle s={s} item={item} open={reply} onPress={() => setReply((value) => !value)} /> : null}
      </View>
      {open && item.kind === "decision" ? <DecisionCard s={s} d={item.decision as Decision} now={nowMs} openAgent={openAgent} chosen={chosen} panelClosed={panelClosed} onResult={onResult} /> : null}
      {open && item.kind !== "decision" ? <AttentionDetail s={s} item={item} nowMs={nowMs} /> : null}
      {urge ? <SendNotice s={s} notice={sender.notice} /> : null}
      {reply ? <LeaderReplyBox s={s} project={item.project} label={item.kind === "question" ? t("leader.ui.replyToThis") : t("leader.ui.writeToLeader")} /> : null}
    </>
  );
}

/** The only thing on a blocking-work row: opens the full card in place, so no letter is ever picked blind. */
function DecideToggle({ s, code, open, chosen, panelClosed, onPress }: { s: Styles; code: string; open: boolean; chosen: boolean; panelClosed: boolean; onPress: () => void }) {
  const label = open ? t("leader.ui.collapse") : panelClosed ? t("leader.attention.undoClose") : chosen ? t("leader.attention.seeResult") : t("leader.attention.decide");
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${label} ${code}`} style={pressed([open ? s.ghost : s.button, { minHeight: 44, justifyContent: "center" }])} onPress={onPress}>
      <Text style={open ? s.ghostText : s.buttonText}>{label}</Text>
    </Pressable>
  );
}

function ReplyToggle({ s, item, open, onPress }: { s: Styles; item: AttentionItem; open: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${open ? t("leader.attention.closeReply") : t("leader.attention.reply")} ${item.code}`} style={pressed(open ? s.ghost : s.button)} onPress={onPress}>
      <Text style={open ? s.ghostText : s.buttonText}>{open ? t("leader.ui.collapse") : t("leader.attention.reply")}</Text>
    </Pressable>
  );
}

function AttentionDetail({ s, item, nowMs }: { s: Styles; item: AttentionItem; nowMs: number }) {
  if (item.kind === "decision") return null;
  if (item.kind === "question") {
    return (
      <>
        <Text style={s.muted}>{t("leader.attention.askedAgo", { elapsed: elapsedLabel(item.at, nowMs) })}</Text>
        <Text style={s.text}>{item.text}</Text>
      </>
    );
  }
  return null;
}
