import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { cardDecisions, decisionCardCodes, latestComment, cardHoldReason, decisionGroups, projectAttentionTotals, type DecisionsSnapshot, type DecisionView, type LeaderTarget } from "../shared/decisions";
import { t } from "../shared/i18n";
import { Badge, Banner, Button, elapsed, type Styles } from "./ui";

function missingLeaderReason(): string {
  return t("decisions.leader.missing");
}

function LeaderButton({ s, target = { agentId: null, reason: missingLeaderReason() }, label, context, openAgent }: {
  s: Styles; target?: LeaderTarget; label: string; context: string; openAgent: (id: string) => void;
}) {
  const disabled = !target.agentId;
  return (
    <View style={{ gap: 4, maxWidth: "100%" }}>
      <Button s={s} label={label} tone="secondary" disabled={disabled}
        accessibilityLabel={`${label} · ${context}`}
        onPress={() => { if (target.agentId) openAgent(target.agentId); }} />
      {disabled ? <Text style={s.muted}>{target.reason || missingLeaderReason()}</Text> : null}
    </View>
  );
}

export type ResolveCard = (code: string) => Promise<{ id: number | null; message: string | null }>;

function DecisionRow({ s, decision, openAgent, resolveCard, onOpenCard }: {
  s: Styles; decision: DecisionView; openAgent: (id: string) => void; resolveCard: ResolveCard; onOpenCard: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const codes = decisionCardCodes(decision);
  const latest = latestComment(decision);
  const comments = decision.userComments ?? [];
  const owner = decision.owner || `${decision.project} <leader>`;

  async function openCard(code: string): Promise<boolean> {
    try {
      const found = await resolveCard(code);
      if (found.id !== null) { setNotice(null); onOpenCard(found.id); return true; }
      setNotice(found.message || t("decisions.card.notFound", { code }));
    } catch (err) {
      setNotice(t("decisions.card.openFailed", { code, error: String(err) }));
    }
    return false;
  }
  /** Main tap: the card it is about, else the leader's conversation, else just show the full text. */
  async function jump() {
    for (const code of codes) if (await openCard(code)) return;
    if (decision.leader.agentId) { openAgent(decision.leader.agentId); return; }
    setExpanded(true);
  }
  return (
    <View testID={`decision-${decision.id}`} style={[s.listRow, decision.blocking ? { borderLeftWidth: 3, borderLeftColor: s.p.danger, paddingLeft: 12 } : {}]}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.row.open", { title: decision.title })} onPress={() => { void jump(); }} style={{ gap: 6 }}>
        <View style={s.row}>
          {decision.blocking ? <Badge s={s} tone="danger" label={t("decisions.row.blocking")} /> : null}
          <Text style={s.muted}>{t("decisions.row.meta", { project: decision.project, owner, age: elapsed(decision.createdAt) })}</Text>
        </View>
        <Text style={[s.cardTitle, decision.blocking ? { color: s.p.danger } : {}]}>{decision.title}</Text>
        {latest && !expanded ? <Text style={s.secondary} numberOfLines={2}>{t("decisions.row.comment", { age: elapsed(latest.at), note: latest.note })}</Text> : null}
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.row.options", { title: decision.title })}
        accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)}>
        <Text style={s.muted}>{expanded ? t("decisions.row.collapse") : comments.length ? t("decisions.row.expandWithComments", { count: comments.length }) : t("decisions.row.expand")}</Text>
      </Pressable>
      {expanded ? (
        <View style={{ gap: 6 }}>
          <Text style={s.text}>{decision.detail || t("decisions.row.noDetail")}</Text>
          {comments.map((comment, index) => (
            <Text key={`${comment.at}-${index}`} style={s.secondary}>{t("decisions.row.comment", { age: elapsed(comment.at), note: comment.note })}</Text>
          ))}
        </View>
      ) : null}
      {codes.length ? (
        <View style={s.row}>
          {codes.map((code) => (
            <Button key={code} s={s} label={t("decisions.row.openCode", { code })} tone="secondary" accessibilityLabel={t("decisions.row.openCodeLabel", { code, title: decision.title })}
              onPress={() => { void openCard(code); }} />
          ))}
        </View>
      ) : null}
      {notice ? <Text style={s.warn}>{notice}</Text> : null}
      <LeaderButton s={s} target={decision.leader} label={t("decisions.row.goLeader")} context={decision.title} openAgent={openAgent} />
    </View>
  );
}

export function DecisionsPanel({ s, snapshot, openAgent, resolveCard = async (code) => ({ id: null, message: t("decisions.card.notFound", { code }) }), onOpenCard = () => {} }: {
  s: Styles; snapshot?: DecisionsSnapshot; openAgent: (id: string) => void; resolveCard?: ResolveCard; onOpenCard?: (id: number) => void;
}) {
  if (!snapshot) return null;
  if (snapshot.message) return <Banner s={s} tone="warning" text={snapshot.message} />;
  if (!snapshot.items.length) return null;
  return (
    <View testID="decisions-panel" style={[s.card, { borderColor: s.p.warning, borderTopWidth: 3 }]}>
      <Text style={s.h2}>{t("boardView.tab.decisions")} <Text style={s.count}>{snapshot.items.length}</Text></Text>
      {decisionGroups(snapshot.items).map((group) => (
        <View key={group.project} style={{ gap: 8 }}>
          <Text style={s.cardTitle}>{t("decisions.group.title", { project: group.project, count: group.items.length })}</Text>
          {group.items.map((decision) => <DecisionRow key={decision.id} s={s} decision={decision} openAgent={openAgent} resolveCard={resolveCard} onOpenCard={onOpenCard} />)}
        </View>
      ))}
    </View>
  );
}

export type AttentionTask = {
  code: string; project: string; status: string; blockedReason: string | null; nextStep: string | null;
  returnNote: string | null; unattended: boolean; stallNote: string | null;
};

export function CardAttention({ s, task, decisions = [], leader, openAgent }: {
  s: Styles; task: AttentionTask; decisions?: readonly DecisionView[]; leader?: LeaderTarget; openAgent: (id: string) => void;
}) {
  const matches = cardDecisions(task.code, decisions);
  const decision = matches[0];
  const reason = cardHoldReason(task);
  if (!decision && !reason) return null;
  return (
    <View testID="card-attention" style={{ gap: 8 }}>
      {decision ? (
        <View style={{ gap: 4 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.card.goLeader", { code: task.code })}
            accessibilityState={{ disabled: !decision.leader.agentId }} disabled={!decision.leader.agentId}
            style={{ alignSelf: "flex-start", minHeight: 44, justifyContent: "center", paddingVertical: 8, opacity: decision.leader.agentId ? 1 : 0.45 }}
            onPress={decision.leader.agentId ? () => openAgent(decision.leader.agentId!) : undefined}>
            <Badge s={s} tone={decision.blocking ? "danger" : "warning"} label={`${t("boardView.attention.decision")}${matches.length > 1 ? ` ${matches.length}` : ""}`} dot />
          </Pressable>
          {!decision.leader.agentId ? <Text style={s.muted}>{decision.leader.reason || missingLeaderReason()}</Text> : null}
        </View>
      ) : null}
      {reason ? (
        <View style={{ gap: 6 }}>
          <Text style={task.status === "blocked" ? s.bad : s.warn}>{t("boardView.blocked.where", { reason })}</Text>
          <LeaderButton s={s} target={leader} label={t("decisions.card.findLeader")} context={task.code} openAgent={openAgent} />
        </View>
      ) : null}
    </View>
  );
}

export function ProjectAttention({ s, tasks, decisions, unreadable }: {
  s: Styles; tasks: ReadonlyArray<{ project: string; status: string }>; decisions: readonly DecisionView[]; unreadable: boolean;
}) {
  return (
    <View testID="project-attention" style={{ gap: 4 }}>
      {projectAttentionTotals(tasks, decisions).map((total) => (
        <Text key={total.project} style={s.secondary}>
          {t("decisions.project.totals", { project: total.project, acceptance: total.acceptance, blocked: total.blocked, decisions: unreadable ? t("labels.assigner.unknown") : total.decisions })}
        </Text>
      ))}
    </View>
  );
}
