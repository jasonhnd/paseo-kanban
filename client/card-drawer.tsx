import { useRpc } from "./rpc";
import { copyText as hostCopyText } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "./query";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { handlingGuide, handoffDigest, holdRoundBlocks, recentEvents, type HandlingGuide } from "../shared/board-view";
import { cardDecisions, type DecisionView, type LeaderTarget } from "../shared/decisions";
import { t, type MessageKey } from "../shared/i18n";
import { cardEffortLabel, cardFaceTone, cardTierLabel, eventHeadline, LEADER_LABEL, statusLabel, workspaceLine } from "../shared/labels";
import { taskRpc, type TaskDetailView } from "../shared/rpc";
import { scheduledWaitLabel } from "../shared/blocked";
import { CardAttention } from "./decisions";
import { eventExtra, eventLabel, FiveFacts, taskAlerts } from "./card-parts";
import { IdentityLines } from "./identity-lines";
import { AlertLine, Badge, Button, Chip, Empty, formatWhen, pressed, type Styles } from "./ui";

export interface DrawerActions {
  start: (id: number) => void;
  unblock: (id: number) => void;
  archive: (id: number) => void;
  setTier: (id: number, tier: string) => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await hostCopyText(text);
    return true;
  } catch {
    return false;
  }
}

function CommandLine({ s, command }: { s: Styles; command: string }) {
  const [copied, setCopied] = useState<"idle" | "ok" | "no">("idle");
  return (
    <View style={s.command}>
      <Text selectable style={[s.mono, { flex: 1, minWidth: 0, color: s.p.text }]}>{command}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("cardDrawer.command.copyLabel", { command })}
        style={pressed({ paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: "center" })}
        onPress={() => void copyText(command).then((ok) => setCopied(ok ? "ok" : "no"))}
      >
        <Text style={[s.muted, { color: s.p.accent }]}>{copied === "ok" ? t("cardDrawer.command.copied") : copied === "no" ? t("cardDrawer.command.selectByHand") : t("cardDrawer.command.copy")}</Text>
      </Pressable>
    </View>
  );
}

function GuideSection({ s, guide }: { s: Styles; guide: HandlingGuide }) {
  const accent = guide.needsPerson ? s.p.warning : s.p.accent;
  return (
    <View testID="handling-guide" style={[s.card, { borderLeftWidth: 3, borderLeftColor: accent }]}>
      <Text style={s.h2}>{t("cardDrawer.guide.title")}</Text>
      <Badge s={s} tone={guide.needsPerson ? "warning" : "accent"} label={guide.needsPerson ? t("cardDrawer.guide.needsPerson", { headline: guide.headline }) : t("cardDrawer.guide.noPerson", { headline: guide.headline })} />
      {guide.steps.map((step) => <Text key={step} style={s.text}>{step}</Text>)}
      {guide.commands.map((command) => <CommandLine key={command} s={s} command={command} />)}
    </View>
  );
}

function HoldRounds({ s, rounds }: { s: Styles; rounds: TaskDetailView["holdRounds"] }) {
  const [openFindings, setOpenFindings] = useState<Record<number, boolean>>({});
  if (rounds.length === 0) return null;
  return (
    <View testID="hold-rounds" style={s.card}>
      <Text style={s.h2}>{t("cardDrawer.hold.title")}</Text>
      {holdRoundBlocks(rounds).map((block, index) => (
        <View key={block.title} style={{ gap: 4 }}>
          <Text style={s.muted}>{block.title}</Text>
          <Text selectable style={s.text}>{block.reason}</Text>
          {block.findings ? (
            <>
              <Button s={s} tone="secondary" label={openFindings[index] ? t("cardDrawer.hold.hideFindings") : t("cardDrawer.hold.showFindings")} accessibilityLabel={`${block.title} findings`} onPress={() => setOpenFindings((current) => ({ ...current, [index]: !current[index] }))} />
              {openFindings[index] ? <Text selectable style={s.text}>{block.findings}</Text> : null}
            </>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Section({ s, title, children }: { s: Styles; title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.h2}>{title}</Text>
      {children}
    </View>
  );
}

function Links({ s, items, label, onOpen }: { s: Styles; items: TaskDetailView["parents"]; label: string; onOpen: (id: number) => void }) {
  return (
    <>
      {items.map((item) => (
        <Pressable key={`${label}${item.id}`} accessibilityRole="button" accessibilityLabel={t("cardDrawer.links.jump", { label, code: item.code })} onPress={() => onOpen(item.id)} style={pressed({ paddingVertical: 6, minHeight: 36, justifyContent: "center" })}>
          <Text style={[s.text, { color: s.p.accent }]}>{label} {item.code} {item.title}{t("common.paren", { text: statusLabel(item.status) })}</Text>
        </Pressable>
      ))}
    </>
  );
}

function ReviewAndHandoff({ s, data }: { s: Styles; data: TaskDetailView }) {
  const digest = handoffDigest(data.task.handoff);
  const review = data.review;
  const hasDigest = Boolean(digest.summary || digest.verification || digest.risks || digest.files);
  return (
    <>
      {data.runBudget ? <Section s={s} title={t("runBudget.title")}>
        <Text style={s.text}>{t("runBudget.totals", { durationMs: data.runBudget.durationMs, turns: data.runBudget.turns, tokens: data.runBudget.tokens, cached: data.runBudget.cachedInputTokens, waits: data.runBudget.consecutiveWaits })}</Text>
        <Text style={s.muted}>{t("runBudget.limitSummary", data.runBudget.limits)}</Text>
        <Text style={s.muted}>{t("runBudget.source", { source: data.runBudget.source, status: data.runBudget.tokenStatus })}</Text>
        {data.runBudget.notes.length ? <Text style={s.muted}>{t("runBudget.notes", { notes: data.runBudget.notes.join("; ") })}</Text> : null}
      </Section> : null}
      <Section s={s} title={t("cardDrawer.handoff.title")}>
        {hasDigest ? (
          <>
            {digest.summary ? <Text style={s.text}>{digest.summary}</Text> : null}
            {digest.files ? <Text style={s.muted}>{t("cardDrawer.handoff.files", { files: digest.files })}</Text> : null}
            {digest.verification ? <Text style={s.muted}>{t("cardDrawer.handoff.verification", { verification: digest.verification })}</Text> : null}
            {digest.risks ? <Text style={s.muted}>{t("cardDrawer.handoff.risks", { risks: digest.risks })}</Text> : null}
          </>
        ) : <Empty s={s} text={t("cardDrawer.handoff.none")} />}
      </Section>
      <Section s={s} title={t("cardDrawer.review.title")}>
        {review ? (
          <>
            <Text style={s.text}>{verdictLabel(review.kind)}{review.actor ? ` · ${review.actor}` : ""} · {formatWhen(review.at)}</Text>
            {review.summary ? <Text style={s.text}>{review.summary}</Text> : null}
          </>
        ) : <Empty s={s} text={t("cardDrawer.review.none")} />}
      </Section>
    </>
  );
}

const VERDICT_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  approve: "cardDrawer.verdict.approve",
  request_changes: "labels.caption.reviewRejectBare",
  rejected: "labels.caption.leaderRejectBare",
  leader_rework: "cardDrawer.verdict.leaderRework",
  leader_pass: "cardDrawer.verdict.leaderPass",
};

function verdictLabel(kind: string): string {
  const key = VERDICT_LABEL_KEYS[kind];
  return key ? t(key, { leader: LEADER_LABEL }) : kind;
}

function PrSection({ s, pr }: { s: Styles; pr: TaskDetailView["pr"] }) {
  if (!pr) return null;
  const check = pr.check;
  return (
    <Section s={s} title={t("cardDrawer.pr.title")}>
      <Text style={s.mono} selectable>{pr.url ?? (pr.repo ? t("cardDrawer.pr.noUrl", { repo: pr.repo }) : t("cardDrawer.pr.none"))}</Text>
      <Text style={s.muted}>
        {pr.awaiting ? t("cardDrawer.pr.awaiting") : t("cardDrawer.pr.notAwaiting")}
        {check ? ` · ${t("cardDrawer.pr.lastCheck", { check: checkLabel(check.kind), when: formatWhen(check.at) })}${check.summary ? t("common.paren", { text: check.summary }) : ""}` : ` · ${t("cardDrawer.pr.noCheck")}`}
      </Text>
    </Section>
  );
}

const CHECK_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  pr_wait: "cardDrawer.check.wait",
  pr_failed: "cardDrawer.check.failed",
  pr_error: "cardParts.event.prError",
};

function checkLabel(kind: string): string {
  const key = CHECK_LABEL_KEYS[kind];
  return key ? t(key) : kind;
}

function Timeline({ s, events }: { s: Styles; events: TaskDetailView["events"] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = recentEvents(events, expanded);
  return (
    <Section s={s} title={t("cardDrawer.timeline.title")}>
      {shown.length === 0 ? <Empty s={s} text={t("cardDrawer.timeline.none")} /> : null}
      {shown.map((item) => (
        <Text key={item.id} style={s.muted}>
          {item.at.slice(0, 16).replace("T", " ")} {eventHeadline(item.kind, item.data) ?? eventLabel(item.kind) ?? item.kind}
          {item.fromStatus ? ` ${statusLabel(item.fromStatus)} → ${statusLabel(item.toStatus ?? "")}` : ""}
          {item.actor ? ` · ${item.actor}` : ""}
          {eventExtra(item.data, item.kind === "request_changes")}
        </Text>
      ))}
      {events.length > 5 ? <Button s={s} tone="secondary" label={expanded ? t("cardDrawer.timeline.collapse") : t("cardDrawer.timeline.expand", { count: Math.min(20, events.length) })} onPress={() => setExpanded((open) => !open)} /> : null}
    </Section>
  );
}

function DrawerBody({ s, data, decisions, leader, actions, openAgent, onOpen }: {
  s: Styles;
  data: TaskDetailView;
  decisions: readonly DecisionView[];
  leader?: LeaderTarget;
  actions: DrawerActions;
  openAgent: (agentId: string) => void;
  onOpen: (id: number) => void;
}) {
  const { task } = data;
  const place = workspaceLine({ kind: task.workspaceKind, path: task.workspacePath, base: task.workspaceBase, branch: task.branch, lane: task.lane });
  const decisionCount = cardDecisions(task.code, decisions).length;
  const guide = handlingGuide(task, { parents: data.parents, decisionCount });
  return (
    <View style={{ gap: 16 }}>
      <GuideSection s={s} guide={guide} />
      {task.leaderHold ? <HoldRounds s={s} rounds={data.holdRounds ?? []} /> : null}
      <CardAttention s={s} task={task} decisions={decisions} leader={leader} openAgent={openAgent} />
      {taskAlerts(task).map((alert) => <AlertLine key={alert.text} s={s} tone={alert.tone} text={alert.text} />)}
      <FiveFacts s={s} task={task} />
      <Section s={s} title={t("cardDrawer.brief.title")}><Text selectable style={s.text}>{task.brief || t("cardDrawer.brief.none")}</Text></Section>
      <ReviewAndHandoff s={s} data={data} />
      <Section s={s} title={t("cardDrawer.links.title")}>
        {data.parents.length === 0 && data.children.length === 0 ? <Empty s={s} text={t("cardDrawer.links.none")} /> : null}
        <Links s={s} items={data.parents} label={t("cardDrawer.links.parent")} onOpen={onOpen} />
        <Links s={s} items={data.children} label={t("cardDrawer.links.child")} onOpen={onOpen} />
      </Section>
      <PrSection s={s} pr={data.pr} />
      <Section s={s} title={t("cardDrawer.runs.title")}>
        <IdentityLines s={s} roleLabel={task.roleLabel} currentText={task.currentText} executorText={task.executorText} agentId={task.agentId} executorAgentId={task.executorAgentId} startedAt={task.startedAt} onOpen={openAgent} />
        {data.runs.length === 0 ? <Empty s={s} text={t("cardDrawer.runs.none")} /> : null}
        {data.runs.map((run) => (
          <View key={run.id} style={s.compactCard}>
            <Text style={s.text}>{run.roleLabel}{run.profileName ? ` · ${run.profileName}` : ""}</Text>
            <Text style={s.mono}>
              {run.provider && run.model ? `${run.provider}/${run.model}` : t("cardDrawer.runs.noModel")}
              {run.agentId ? ` · ${run.agentId.slice(0, 8)}` : ""}
              {run.endKind ? ` · ${run.endKind}` : ` · ${t("labels.status.running")}`}
            </Text>
            {run.agentId ? <Button s={s} label={t("cardDrawer.runs.open")} tone="secondary" accessibilityLabel={t("cardDrawer.runs.openLabel")} onPress={() => openAgent(run.agentId as string)} /> : null}
          </View>
        ))}
      </Section>
      <Timeline s={s} events={data.events} />
      {data.comments.length > 0 ? (
        <Section s={s} title={t("cardDrawer.comments.title")}>
          {data.comments.map((item) => (
            <View key={item.id} style={s.compactCard}>
              <Text style={s.muted}>{item.author} · {item.createdAt.slice(0, 16).replace("T", " ")}</Text>
              <Text style={s.text}>{item.body}</Text>
            </View>
          ))}
        </Section>
      ) : null}
      <Section s={s} title={t("cardDrawer.settings.title")}>
        <View style={s.row}>
          <Button s={s} label={t("cardDrawer.settings.start")} onPress={() => actions.start(task.id)} />
          <Button s={s} label={t("cardDrawer.settings.unblock")} tone="secondary" onPress={() => actions.unblock(task.id)} />
          <Button s={s} label={t("cardDrawer.settings.archive")} tone="danger" onPress={() => actions.archive(task.id)} />
        </View>
        <Text style={s.muted}>{cardTierLabel(task.tierLabel)}{task.tier ? "" : t("cardDrawer.settings.tierUnset")}{task.effort ? ` · ${cardEffortLabel(task.effort)}` : ""}</Text>
        <View style={s.row}>
          {["", "L1", "L2", "L3", "L4"].map((value) => (
            <Chip key={value || "none"} s={s} label={value || t("cardDrawer.settings.noTier")} active={(task.tier ?? "") === value} onPress={() => actions.setTier(task.id, value)} />
          ))}
        </View>
        {place ? <Text style={s.muted}>{place}</Text> : null}
        {task.paseoWorkspace ? <Text style={s.muted}>Paseo workspace {task.paseoWorkspace}</Text> : null}
        {task.tags.length > 0 ? <Text style={s.muted}>{t("cardDrawer.settings.tags", { tags: task.tags.join(t("common.listSep")) })}</Text> : null}
        <Text style={s.muted}>{t("cardDrawer.settings.meta", { project: task.project, round: task.reviewRound, contract: task.contract })}</Text>
      </Section>
    </View>
  );
}

/** Side drawer over the board. On a phone it covers the whole screen. */
export function CardDrawer({ s, id, decisions, leaders, actions, openAgent, onOpen, onClose }: {
  s: Styles;
  id: number;
  decisions: readonly DecisionView[];
  leaders: Record<string, LeaderTarget>;
  actions: DrawerActions;
  openAgent: (agentId: string) => void;
  onOpen: (id: number) => void;
  onClose: () => void;
}) {
  const loadTask = useRpc(taskRpc);
  const detail = useQuery({ queryKey: ["kanban", "task", id], queryFn: () => loadTask({ id }) });
  const data = detail.data;
  return (
    <View testID="card-drawer" style={s.overlay}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("cardDrawer.close.label")} style={s.backdrop} onPress={onClose} />
      <View style={s.drawer}>
        <View style={[s.between, { padding: 12, borderBottomWidth: 1, borderBottomColor: s.p.border }]}>
          <View style={s.cardHead}>
            {data ? <Text style={s.mono}>{data.task.code}</Text> : null}
            {data ? <Badge s={s} label={data.task.status === "blocked" && data.task.blockedKind === "scheduled" && data.task.scheduledUntil ? scheduledWaitLabel(data.task.scheduledUntil) : data.task.badge} tone={cardFaceTone(data.task)} dot /> : null}
          </View>
          <Button s={s} label={t("cardDrawer.close.button")} tone="secondary" accessibilityLabel={t("cardDrawer.close.label")} onPress={onClose} />
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
          {detail.isError ? <Text style={s.bad}>{t("cardDrawer.load.failed", { error: String(detail.error) })}</Text> : null}
          {!data && !detail.isError ? <Empty s={s} text={t("cardDrawer.load.loading")} /> : null}
          {data ? <Text style={s.title}>{data.task.title}</Text> : null}
          {data ? <DrawerBody s={s} data={data} decisions={decisions} leader={leaders[data.task.project]} actions={actions} openAgent={openAgent} onOpen={onOpen} /> : null}
        </ScrollView>
      </View>
    </View>
  );
}
