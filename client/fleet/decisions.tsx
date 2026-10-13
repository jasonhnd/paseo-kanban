import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type BoardSnapshot, decideReplyRpc, decisionMaintEnabledRpc, overturnDecisionRpc } from "../../shared/fleet/board";
import { clipError } from "../../shared/fleet/clip-error";
import { cardSummaryLine, type ChosenState, effectiveProjectFilter, filterByProject, projectTags, sortCardRows } from "../../shared/fleet/decision-card";
import { addSet, decisionsLookEmpty, hintUnread, shelveConfirm } from "../../shared/fleet/decisions-view";
import { t } from "../../shared/fleet/i18n";
import { noLeaderHint, noLeaderTitle, partitionUnownedDecisions, shelveUnownedGroup, type UnownedGroup } from "../../shared/fleet/unowned-decisions";
import { OpenSession, type ReplyMessage } from "./decision-actions";
import { type Decision, DecisionCard } from "./decision-card";
import { usePanelClosedRows, type PanelClosedRow } from "./panel-closed-rows";
import { Badge, Empty, type OpenAgent, pressed, ResponsiveGrid, Section, type Styles } from "./ui";

const CARD_MIN_WIDTH = 340;
const MAX_CARD_COLUMNS = 2;

/** All open decisions as one list of cards: summary and project filter on top, blocking first. */
export function Decisions({ s, data, openAgent, showSettings = true, sectionTitle }: { s: Styles; data: BoardSnapshot; openAgent: OpenAgent; showSettings?: boolean; sectionTitle?: string }) {
  const model = useDecisionLists(data);
  // A titled section stays mounted when the parent always renders it, so a panel close can keep its undo row after the open list drops the item.
  if (sectionTitle && model.cards.length === 0 && model.unowned.length === 0 && model.unread.length === 0) return null;
  const body = (
    <View style={{ gap: 16 }}>
      {sectionTitle ? <Text style={s.h2}>{sectionTitle}</Text> : null}
      {showSettings ? <DecisionSettings s={s} enabled={data.decisionMaint.enabled} /> : null}
      {model.empty ? <Empty s={s} text={t("decisions.list.empty")} /> : null}
      {model.cards.length > 0 ? <SummaryBar s={s} model={model} /> : null}
      {model.unowned.map((group) => <NoLeaderDecisionGroup key={group.project.toLowerCase()} s={s} group={group} />)}
      {model.visible.length > 0 ? (
        <ResponsiveGrid s={s} maxColumns={MAX_CARD_COLUMNS} minCellWidth={CARD_MIN_WIDTH} rowGap={16}>
          {model.visible.map((row) => (
            <DecisionCard key={row.id} s={s} d={row} now={model.now} openAgent={openAgent} deferred={model.deferred.has(row.id)} chosen={model.chosen.get(row.id)?.chosen ?? null} panelClosed={model.panelClosed.has(row.id)} onDefer={model.defer} onResult={(message) => model.note(row, message)} />
          ))}
        </ResponsiveGrid>
      ) : null}
      <UnreadSection s={s} rows={model.unread} openAgent={openAgent} />
    </View>
  );
  return sectionTitle ? <View style={s.card}>{body}</View> : body;
}

export interface KeptChoice { decision: Decision; chosen: ChosenState }

function useDecisionLists(data: BoardSnapshot) {
  const [deferred, setDeferred] = useState<Set<string>>(new Set());
  const [session, setKept] = useState<ReadonlyMap<string, KeptChoice>>(new Map());
  const { held, note: noteClose } = usePanelClosedRows<Decision>(data);
  const kept = useMemo(() => mergeKept(storedKept(data.recentChoices ?? []), session), [data.recentChoices, session]);
  const [filter, setFilter] = useState<string | null>(null);
  const now = Date.parse(data.generatedAt) || Date.now();
  const base = useMemo(() => withKept(data.decisions.filter((row) => row.kind === "decide"), kept), [data.decisions, kept]);
  const cards = useMemo(() => withHeld(base, held), [base, held]);
  const panelClosed = useMemo(() => closedIds(held), [held]);
  const unread = useMemo(() => data.decisions.filter((row) => row.kind === "unread"), [data.decisions]);
  const unowned = useMemo(() => partitionUnownedDecisions(data.decisions.filter((row) => row.kind === "decide")).unowned, [data.decisions]);
  const settled = useMemo(() => new Set([...deferred, ...kept.keys(), ...panelClosed]), [deferred, kept, panelClosed]);
  const processed = useMemo(() => new Set([...kept.keys(), ...panelClosed]), [kept, panelClosed]);
  const sorted = useMemo(() => sortCardRows(cards, now, settled), [cards, now, settled]);
  const active = effectiveProjectFilter(sorted, filter);
  const visible = useMemo(() => filterByProject(sorted, active), [sorted, active]);
  const empty = decisionsLookEmpty(cards.length, 0, unread.length, 0, 0);
  const defer = (id: string) => setDeferred((prev) => addSet(prev, id));
  const note = (row: Decision, message: ReplyMessage) => {
    const chosen = message.chosen;
    if (chosen) setKept((prev) => new Map(prev).set(row.id, { decision: row, chosen }));
    noteClose(row.id, row, message);
  };
  return { now, cards, unread, unowned, sorted, visible, deferred, settled, processed, chosen: kept, panelClosed, filter: active, setFilter, empty, defer, note };
}

/** A panel-closed row stays until the open list has it again. */
function withHeld(rows: Decision[], held: ReadonlyMap<string, PanelClosedRow<Decision>>): Decision[] {
  const open = new Set(rows.map((row) => row.id));
  const extra = [...held.values()].filter((entry) => !open.has(entry.row.id)).map((entry) => entry.row);
  return [...rows, ...extra];
}

function closedIds(held: ReadonlyMap<string, PanelClosedRow<Decision>>): Set<string> {
  // Successful local closes take effect before the refreshed open snapshot arrives.
  return new Set([...held.values()].filter((entry) => entry.closed).map((entry) => entry.row.id));
}

/** Answers stored by the server (last 24 hours) come back as answered cards when the panel is opened again. */
export function storedKept(choices: BoardSnapshot["recentChoices"]): ReadonlyMap<string, KeptChoice> {
  return new Map(choices.map((choice) => [choice.id, {
    decision: { id: choice.id, project: choice.project, title: choice.title, detail: choice.detail, blocking: choice.blocking, kind: "decide", source: choice.source, createdAt: choice.createdAt, agentId: choice.agentId },
    chosen: { id: choice.id, letter: choice.letter, message: "", at: Date.parse(choice.doneAt) },
  }]));
}

/** This session's own picks win over what was read back, since they may be a newer change. */
export function mergeKept(stored: ReadonlyMap<string, KeptChoice>, session: ReadonlyMap<string, KeptChoice>): ReadonlyMap<string, KeptChoice> {
  const answerIds = new Set([...session.values()].map((entry) => entry.chosen.id));
  return new Map([...[...stored].filter(([id]) => !answerIds.has(id)), ...session]);
}

/** Rows already answered stay on screen even after the snapshot drops them, so the user sees the result. */
function withKept(rows: Decision[], kept: ReadonlyMap<string, KeptChoice>): Decision[] {
  const open = new Set(rows.map((row) => row.id));
  const gone = [...kept.values()].filter((entry) => !open.has(entry.decision.id)).map((entry) => entry.decision);
  return [...rows, ...gone];
}

function SummaryBar({ s, model }: { s: Styles; model: ReturnType<typeof useDecisionLists> }) {
  const tags = projectTags(model.sorted);
  return (
    <View style={{ gap: 8 }}>
      <Text style={[s.h2, { fontWeight: "700" }]}>{cardSummaryLine(model.sorted, model.settled)}{model.processed.size > 0 ? ` · ${t("decisions.card.processed", { count: model.processed.size })}` : ""}</Text>
      {tags.length > 0 ? (
        <View style={[s.row, { gap: 8 }]}>
          <FilterChip s={s} label={t("decisions.list.filterAll", { count: model.sorted.length })} on={model.filter === null} onPress={() => model.setFilter(null)} />
          {tags.map((tag) => <FilterChip key={tag.project} s={s} label={`${tag.project} ${tag.count}`} on={model.filter === tag.project} onPress={() => model.setFilter(tag.project)} />)}
        </View>
      ) : null}
    </View>
  );
}

function FilterChip({ s, label, on, onPress }: { s: Styles; label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={t("decisions.list.filterOnly", { label })} style={pressed({ minHeight: 44, paddingHorizontal: 12, justifyContent: "center", borderRadius: 22, borderWidth: 1, borderColor: on ? s.p.primaryBg : s.p.border, backgroundColor: on ? s.p.primaryBg : s.p.transparent })} onPress={onPress}>
      <Text style={[s.ghostText, { color: on ? s.p.primaryFg : s.p.text, fontWeight: on ? "600" : "400" }]}>{label}</Text>
    </Pressable>
  );
}

/** One project without a <leader>: one explicit confirmation shelves all its cards. The cards stay in the list. */
export function NoLeaderDecisionGroup({ s, group }: { s: Styles; group: UnownedGroup<Decision> }) {
  const shelve = useShelve(group);
  return (
    <View style={[s.card, { gap: 8, backgroundColor: s.p.amberBg }]}>
      <Text style={[s.text, { fontWeight: "600" }]}>{noLeaderTitle(group.project)}</Text>
      <Text style={s.muted}>{noLeaderHint()}</Text>
      {shelveControls(s, group, shelve)}
      {shelve.result ? <Text style={shelve.result.ok ? s.green : s.red}>{shelve.result.message}</Text> : null}
    </View>
  );
}

function useShelve(group: UnownedGroup<Decision>) {
  const reply = useRpc(decideReplyRpc);
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const run = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await shelveUnownedGroup(group, confirm, reply));
    } finally {
      setConfirm(false);
      setBusy(false);
      void client.invalidateQueries({ queryKey: ["afc", "snapshot"] });
    }
  };
  return { confirm, setConfirm, busy, result, setResult, run };
}

function shelveControls(s: Styles, group: UnownedGroup<Decision>, shelve: ReturnType<typeof useShelve>) {
  if (!shelve.confirm) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.list.shelveAllLabel", { project: group.project })} disabled={shelve.busy} style={pressed([s.ghost, { alignSelf: "flex-start" }])} onPress={() => { shelve.setResult(null); shelve.setConfirm(true); }}>
        <Text style={s.dangerText}>{t("decisions.list.shelveAll")}</Text>
      </Pressable>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.text}>{shelveConfirm(group.project, group.items.length)}</Text>
      <View style={s.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.list.shelveAllConfirmLabel", { project: group.project, count: group.items.length })} disabled={shelve.busy} style={pressed(s.button)} onPress={() => void shelve.run()}>
          <Text style={s.buttonText}>{shelve.busy ? t("decisions.list.shelving") : t("decisions.list.shelveAllConfirm")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.list.shelveAllCancel")} disabled={shelve.busy} style={pressed(s.ghost)} onPress={() => shelve.setConfirm(false)}>
          <Text style={s.ghostText}>{t("decisions.actions.cancel")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function UnreadSection({ s, rows, openAgent }: { s: Styles; rows: Decision[]; openAgent: OpenAgent }) {
  if (rows.length === 0) return null;
  return (
    <Section s={s} title={t("decisions.list.unreadTitle")}>
      <Text style={s.muted}>{hintUnread()}</Text>
      {rows.map((row) => (
        <View key={row.id} style={[s.card, { gap: 8 }]}>
          <Text style={[s.text, { fontWeight: "600" }]}>{row.title}</Text>
          <View style={s.row}>
            <Badge s={s} label={row.project} tone="neutral" />
            {row.owner ? <Badge s={s} label={row.owner} tone="blue" /> : null}
          </View>
          <OpenSession s={s} agentId={row.agentId} openAgent={openAgent} title={row.title} />
        </View>
      ))}
    </Section>
  );
}

export function SupervisorDecisions({ s, data }: { s: Styles; data: BoardSnapshot }) {
  return (
    <View style={{ gap: 8 }}>
      {data.supervisorDecisions.length === 0 ? <Empty s={s} text={t("decisions.list.supervisorEmpty")} /> : null}
      {data.supervisorDecisions.map((row) => <SupervisorRow key={row.id} s={s} row={row} />)}
    </View>
  );
}

function SupervisorRow({ s, row }: { s: Styles; row: BoardSnapshot["supervisorDecisions"][number] }) {
  return (
    <View style={[s.between, s.item]}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={s.muted}>{row.project} · {row.decidedAt.replace("T", " ").slice(0, 16)}</Text>
        <Text style={s.text}>{row.title}</Text>
        {row.note ? <Text style={s.muted} numberOfLines={3}>{row.note}</Text> : null}
      </View>
      <OverturnButton s={s} id={row.id} />
    </View>
  );
}

export function DecisionSettings({ s, enabled }: { s: Styles; enabled: boolean }) {
  return (
    <View style={s.between}>
      <Text style={[s.muted, { flex: 1 }]}>{t("decisions.list.settingsHint")}</Text>
      <DecisionMaintSwitch s={s} enabled={enabled} />
    </View>
  );
}

export function DecisionMaintSwitch({ s, enabled }: { s: Styles; enabled: boolean }) {
  const setEnabled = useRpc(decisionMaintEnabledRpc);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => toggleFlag(enabled, setEnabled, client, setBusy, setError);
  return (
    <View style={{ alignItems: "flex-end", gap: 2 }}>
      <Pressable accessibilityRole="switch" accessibilityLabel={enabled ? t("decisions.list.maintTurnOff") : t("decisions.list.maintTurnOn")} accessibilityState={{ checked: enabled }} disabled={busy} style={pressed(s.ghost)} onPress={toggle}>
        <Text style={enabled ? s.green : s.muted}>{enabled ? t("decisions.list.maintOn") : t("decisions.list.maintOff")}</Text>
      </Pressable>
      {error ? <Text style={s.red}>{error}</Text> : null}
    </View>
  );
}

function toggleFlag(
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

function OverturnButton({ s, id }: { s: Styles; id: string }) {
  const overturn = useRpc(overturnDecisionRpc);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const onPress = () => runOverturn(id, overturn, client, setBusy, setMsg);
  return (
    <View style={{ alignItems: "flex-end", gap: 2 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.list.overturnLabel", { id })} disabled={busy} style={pressed(s.ghost)} onPress={onPress}>
        <Text style={s.dangerText}>{busy ? t("decisions.list.overturning") : t("decisions.list.overturn")}</Text>
      </Pressable>
      {msg ? <Text style={s.muted}>{msg}</Text> : null}
    </View>
  );
}

function runOverturn(
  id: string,
  overturn: (input: { id: string }) => Promise<{ message: string }>,
  client: ReturnType<typeof useQueryClient>,
  setBusy: (busy: boolean) => void,
  setMsg: (message: string | null) => void,
) {
  setBusy(true);
  setMsg(null);
  overturn({ id })
    .then((result) => {
      setMsg(result.message);
      return client.invalidateQueries({ queryKey: ["afc", "snapshot"] });
    })
    .catch((error: unknown) => setMsg(clipError(error, 160)))
    .finally(() => setBusy(false));
}
