import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { BoardSnapshot } from "../../shared/fleet/board";
import { type ChosenState, contextNeedsFold, leaderLabel, noLeaderLabel, parseDecisionCard, waitLabel } from "../../shared/fleet/decision-card";
import { maybeStale } from "../../shared/fleet/decisions";
import { t } from "../../shared/fleet/i18n";
import { canWriteToLeader } from "../../shared/fleet/unowned-decisions";
import { DecisionActions, type ReplyMessage } from "./decision-actions";
import { Badge, OpenRow, type OpenAgent, pressed, type Styles } from "./ui";

export type Decision = BoardSnapshot["decisions"][number];

/** One open decision as one card: question and tags, what is going on, big option buttons, small side actions. */
export function DecisionCard({ s, d, now, openAgent, deferred = false, chosen = null, panelClosed = false, onDefer, onResult }: {
  s: Styles;
  d: Decision;
  now: number;
  openAgent: OpenAgent;
  deferred?: boolean;
  chosen?: ChosenState | null;
  panelClosed?: boolean;
  onDefer?: (id: string) => void;
  onResult?: (message: ReplyMessage) => void;
}) {
  const stored = d.kind === "decide" && d.source !== "Kanban";
  const blocking = d.blocking && !deferred && !chosen && !panelClosed;
  return (
    <View style={[s.card, { gap: 12, width: "100%", borderLeftWidth: 4, borderLeftColor: blocking ? s.p.red : s.p.border, opacity: deferred ? 0.8 : 1 }]}>
      <CardHeader s={s} d={d} now={now} blocking={blocking} deferred={deferred} />
      <Context s={s} title={d.title} detail={d.detail} />
      {stored
        ? <DecisionActions s={s} id={d.id} title={d.title} detail={d.detail} onDefer={deferred ? undefined : onDefer} onResult={onResult} allowText={canWriteToLeader(d)} initialChosen={chosen} initialPanelClosed={panelClosed} />
        : <OpenRow s={s} row={d} openAgent={openAgent} label={t("decisions.cardView.openAgent")} />}
    </View>
  );
}

function CardHeader({ s, d, now, blocking, deferred }: { s: Styles; d: Decision; now: number; blocking: boolean; deferred: boolean }) {
  const leader = leaderLabel(d);
  return (
    <View style={{ gap: 8 }}>
      <Text numberOfLines={2} style={[s.h2, { fontWeight: "700" }]}>{d.title}</Text>
      <View style={[s.row, { gap: 6 }]}>
        <Badge s={s} label={d.project} tone="neutral" />
        {blocking ? <Badge s={s} label={t("decisions.meta.blocking")} tone="red" /> : null}
        {deferred ? <Badge s={s} label={t("decisions.meta.deferred")} tone="yellow" /> : null}
        {maybeStale(d, now) ? <Badge s={s} label={t("decisions.meta.maybeStale")} tone="yellow" /> : null}
        <Badge s={s} label={waitLabel(d.createdAt, now)} tone="neutral" />
        {leader ? <Badge s={s} label={leader} tone={leader === noLeaderLabel() ? "yellow" : "blue"} /> : null}
      </View>
    </View>
  );
}

function Context({ s, title, detail }: { s: Styles; title: string; detail: string }) {
  const context = useMemo(() => parseDecisionCard(title, detail).context, [title, detail]);
  const [open, setOpen] = useState(false);
  if (!context) return null;
  const foldable = contextNeedsFold(context);
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.secondary} numberOfLines={foldable && !open ? 3 : undefined}>{context}</Text>
      {foldable ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={open ? t("decisions.cardView.showLess") : t("decisions.cardView.showAll")} style={pressed({ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" })} onPress={() => setOpen((v) => !v)}>
          <Text style={[s.ghostText, { color: s.p.link }]}>{open ? t("decisions.cardView.showLess") : t("decisions.cardView.showAll")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
