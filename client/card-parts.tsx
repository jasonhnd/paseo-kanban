import { View } from "react-native";
import { blockedKindLabel, cardQueueAlert, scheduledWaitLabel } from "../shared/blocked";
import { summaryCount } from "../shared/event-summary";
import { t, type MessageKey } from "../shared/i18n";
import { isConflictBadge, isLandPendingBadge, LEADER_LABEL } from "../shared/labels";
import type { BoardCardView } from "../shared/rpc";
import { Fact, blockedFor, type Styles } from "./ui";

export function eventExtra(data: string, omitReason = false): string {
  try {
    const parsed = JSON.parse(data) as {
      reason?: string;
      name?: string;
      error?: string;
      agentId?: string;
      workspaceId?: string;
      summary?: number;
      count?: number;
    };
    const bits = [
      typeof parsed.agentId === "string" ? parsed.agentId.slice(0, 8) : "",
      parsed.workspaceId,
      parsed.name,
      omitReason ? "" : parsed.reason,
      parsed.error,
    ].filter((item) => typeof item === "string" && item);
    // A summary row stands for several events of the same kind.
    const repeats = summaryCount(parsed as Record<string, unknown>);
    if (repeats != null && repeats > 1) bits.push(`×${repeats}`);
    return bits.length > 0 ? ` · ${bits.join(" ")}` : "";
  } catch {
    return "";
  }
}

/** Catalog keys of the event names shown in the timeline. */
const EVENT_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  created: "cardParts.event.created",
  tier_changed: "cardParts.event.tierChanged",
  tagged: "cardParts.event.tagged",
  registered: "cardParts.event.registered",
  blocked: "cardParts.event.blocked",
  unblocked: "cardParts.event.unblocked",
  scheduled_resumed: "cardParts.event.scheduledResumed",
  archived: "cardParts.event.archived",
  auto_archived: "cardParts.event.autoArchived",
  claim: "cardParts.event.claim",
  reclaimed: "cardParts.event.reclaimed",
  turn_canceled: "cardParts.event.turnCanceled",
  rebound: "cardParts.event.rebound",
  requeued: "cardParts.event.requeued",
  triage_woke: "cardParts.event.triageWoke",
  wake_acceptance: "cardParts.event.wakeAcceptance",
  rejected: "cardParts.event.rejected",
  reopened: "cardParts.event.reopened",
  wake_blocked: "cardParts.event.wakeBlocked",
  wake_children: "cardParts.event.wakeChildren",
  unattended: "cardParts.event.unattended",
  respawn_guarded: "cardParts.event.respawnGuarded",
  fused: "cardParts.event.fused",
  pr_wait: "cardParts.event.prWait",
  pr_failed: "cardParts.event.prFailed",
  pr_error: "cardParts.event.prError",
  worktree_created: "cardParts.event.worktreeCreated",
  lane_bound: "cardParts.event.laneBound",
  workspace_bound: "cardParts.event.workspaceBound",
  cleanup: "cardParts.event.cleanup",
  cleanup_finished: "cardParts.event.cleanupFinished",
  agent_opened: "cardParts.event.agentOpened",
  start_failed: "cardParts.event.startFailed",
  start_transient: "cardParts.event.startTransient",
};

/** Timeline name of an event kind, or undefined for a kind without one. */
export function eventLabel(kind: string): string | undefined {
  const key = EVENT_LABEL_KEYS[kind];
  return key ? t(key, { leader: LEADER_LABEL }) : undefined;
}

type AlertTask = Pick<BoardCardView, "status" | "badge" | "scheduledUntil" | "blockedReason" | "nextStep" | "blockedKind" | "blockedAt" | "returnNote" | "tempNote" | "unattended" | "awaitingMerge" | "cleanupNote" | "mcpNote" | "stallNote">;

export function taskAlerts(task: AlertTask): Array<{ tone: "warning" | "danger"; text: string }> {
  const alerts: Array<{ tone: "warning" | "danger"; text: string }> = [];
  if (task.status === "blocked" && task.blockedKind === "scheduled" && task.scheduledUntil) {
    alerts.push({ tone: "warning", text: scheduledWaitLabel(task.scheduledUntil) });
  } else if (task.status === "blocked") {
    const reason = task.blockedReason || task.nextStep;
    const kind = task.blockedKind ? ` · ${blockedKindLabel(task.blockedKind)}` : "";
    const head = reason ? t("cardParts.alert.blocked", { reason }) : t("labels.status.blocked");
    alerts.push({ tone: "danger", text: `${head}${kind} · ${blockedFor(task.blockedAt)}` });
  }
  if (task.returnNote) alerts.push({ tone: "warning", text: task.returnNote });
  if (task.tempNote) {
    // The temporary-workspace note starts like the waiting-to-land badge while the card has not landed.
    const conflict = isLandPendingBadge(task.tempNote) && isConflictBadge(task.badge);
    alerts.push({ tone: conflict ? "danger" : "warning", text: task.tempNote });
  }
  const queued = cardQueueAlert(task.status, task.nextStep);
  if (queued) alerts.push({ tone: "warning", text: queued });
  if (task.unattended) alerts.push({ tone: "warning", text: t("cardParts.alert.unattended") });
  if (task.awaitingMerge) alerts.push({ tone: "warning", text: t("cardParts.alert.awaitingMerge") });
  if (task.cleanupNote) alerts.push({ tone: "warning", text: task.cleanupNote });
  if (task.mcpNote) alerts.push({ tone: "warning", text: task.mcpNote });
  if (task.stallNote) alerts.push({ tone: "warning", text: task.stallNote });
  return alerts;
}

type FactTask = Pick<BoardCardView, "assigner" | "related" | "assignee" | "goal" | "acceptance" | "acceptanceMissing">;

export function FiveFacts({ s, task }: { s: Styles; task: FactTask }) {
  return (
    <View style={s.facts}>
      <Fact s={s} label={t("cardParts.fact.assigner")} value={task.assigner} />
      <Fact s={s} label={t("cardParts.fact.related")} value={task.related} />
      <Fact s={s} label={t("cardParts.fact.assignee")} value={task.assignee} />
      <Fact s={s} label={t("cardParts.fact.goal")} value={task.goal} />
      <Fact s={s} label={t("cardParts.fact.acceptance")} value={task.acceptance} tone={task.acceptanceMissing ? "warning" : "text"} />
    </View>
  );
}
