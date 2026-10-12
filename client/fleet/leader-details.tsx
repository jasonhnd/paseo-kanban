import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type BoardSnapshot } from "../../shared/fleet/board";
import { t } from "../../shared/fleet/i18n";
import { acceptanceTone, elapsedLabel, groupLeaderCards, leaderCardGroups, projectDecisions, repeatWakeLabel, unresponsiveCards, type LeaderDetail } from "../../shared/fleet/leader-panel";
import { isUnownedDecision } from "../../shared/fleet/unowned-decisions";
import { DecisionActions } from "./decision-actions";
import { LeaderReplyBox } from "./leader-reply";
import { pressed, type Styles } from "./ui";

/** The contents remain visible by default; on a phone every band can be folded independently. */
function LeaderSection({ s, title, summary, warning, children }: { s: Styles; title: string; summary?: string; warning?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return <View style={{ gap: 8 }}>
    <Pressable accessibilityRole="button" accessibilityState={{expanded:open}} accessibilityLabel={t(summary ? "leader.ui.sectionA11ySummary" : "leader.ui.sectionA11y", { action: open ? t("leader.ui.collapse") : t("leader.ui.expand"), title, summary: summary ?? "" })} style={pressed([s.between, {minHeight:44}])} onPress={() => setOpen(v=>!v)}>
      <Text style={[warning ? s.yellow : s.text,{fontWeight:"600",flexShrink:1}]}>{title}</Text>
      <Text style={s.muted}>{summary}{` · ${open ? t("leader.ui.collapse") : t("leader.ui.expand")}`}</Text>
    </Pressable>
    {open ? children : null}
  </View>;
}
export function Excerpt({ s, text, lines = 4 }: { s: Styles; text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  return <View style={{gap:4}}>
    <Text style={s.text} numberOfLines={open ? undefined : lines}>{text}</Text>
    <Pressable accessibilityRole="button" accessibilityState={{expanded:open}} accessibilityLabel={open ? t("leader.ui.collapseFull") : t("leader.ui.expandFull")} style={pressed([s.ghost,{alignSelf:"flex-start"}])} onPress={()=>setOpen(v=>!v)}><Text style={s.ghostText}>{open ? t("leader.ui.collapseFull") : t("leader.ui.expandFull")}</Text></Pressable>
  </View>;
}

interface HeldDecision { row: BoardSnapshot["decisions"][number]; closed: boolean }

/** `reply` adds the long reply box; the compact card has its own reply line, so only paused projects use it. */
export function LeaderDetails({ s, project, detail, data, paused = false, reply = paused }: { s: Styles; project: string; detail?: LeaderDetail; data: BoardSnapshot; paused?: boolean; reply?: boolean }) {
  const openDecisions = projectDecisions(data.decisions, project).filter(d => !isUnownedDecision(d));
  const [held, setHeld] = useState<ReadonlyMap<string, HeldDecision>>(new Map());
  const openIds = new Set(openDecisions.map((row) => row.id));
  const extras = [...held.values()].filter((entry) => !openIds.has(entry.row.id));
  const decisions = [...openDecisions, ...extras.map((entry) => entry.row)];
  const closedIds = new Set([...held.values()].filter((entry) => entry.closed).map((entry) => entry.row.id));
  const now = Date.parse(data.generatedAt) || Date.now();
  return <View style={{gap:12}}>
    <LeaderSection s={s} title={t("leader.ui.waitingOnYou")} summary={t("leader.ui.itemCount", { count: decisions.filter((row) => !closedIds.has(row.id)).length })}>
      {decisions.length === 0 ? <Text style={s.muted}>{t("leader.ui.noOpenDecisions")}</Text> : decisions.map(d=>{
        const closed = closedIds.has(d.id);
        const blocking = d.blocking && !closed;
        return <View key={d.id} style={[s.item,{gap:8,borderLeftWidth:blocking ? 3 : 0,borderLeftColor:blocking ? s.p.red : s.p.border,paddingLeft:blocking ? 8 : 0}]}>
        <Text style={blocking ? s.red : s.muted}>{blocking ? `${t("leader.ui.blockingWork")} · ` : closed ? `${t("leader.ui.handled")} · ` : ""}{d.id}</Text>
        {d.owner ? <Text style={s.muted}>{t("leader.ui.owner", { owner: d.owner })}{d.forceOpen ? ` · ${t("leader.ui.forceOpen")}` : ""}</Text> : null}
        <Text style={[s.text,{fontWeight:"600"}]}>{d.title}</Text>
        {d.detail ? <Excerpt s={s} text={d.detail} lines={6} /> : null}
        <DecisionActions s={s} id={d.id} title={d.title} detail={d.detail} initialPanelClosed={closedIds.has(d.id)} onResult={(message) => {
          if (message.panelClosed || message.panelRestored) setHeld((prev) => new Map(prev).set(d.id, { row: d, closed: message.panelClosed === true }));
        }} />
      </View>;})}
    </LeaderSection>
    {detail?.question ? <LeaderSection s={s} title={t("leader.ui.askedUnregistered")} summary={t("leader.ui.ago", { elapsed: elapsedLabel(detail.question.at,now) })}>
      <Text style={s.yellow}>{t("leader.ui.mayBeWaiting")}</Text>
      <Excerpt s={s} text={detail.question.text} />
      <LeaderReplyBox s={s} project={project} label={t("leader.ui.replyToThis")} paused={paused} />
    </LeaderSection> : null}
    <LeaderSection s={s} title={t("leader.ui.cardsHere")} summary={detail ? t("leader.ui.cardCount", { count: Object.values(groupLeaderCards(detail.cards)).flat().length }) : t("leader.ui.unreadable")}>
      {detail?.cardsWarning ? <Text style={s.yellow}>{detail.cardsWarning}</Text> : detail ? <LeaderCards s={s} detail={detail} now={now} /> : <Text style={s.muted}>{t("leader.ui.cardsUnreadable")}</Text>}
    </LeaderSection>
    {detail?.selfWorking ? <LeaderSection s={s} title={t("leader.ui.selfWorking")} warning>
      <Text style={s.yellow}>{detail.selfWorkReason}</Text>
      {detail.actions.length === 0 ? <Text style={s.muted}>{t("leader.ui.actionsUnreadable")}</Text> : detail.actions.map((a,i)=><Text key={`${a.at}-${i}`} style={s.muted} numberOfLines={2}>{a.summary}</Text>)}
    </LeaderSection> : null}
    {detail?.activityWarning ? <Text style={s.yellow}>{detail.activityWarning}</Text> : null}
    {reply ? <LeaderSection s={s} title={t("leader.ui.replyToIt")} summary={unresponsiveCards(detail).length > 0 ? t("leader.ui.remindAcceptanceA11y") : undefined}>
      <LeaderReplyBox s={s} project={project} cards={detail?.cards ?? []} unresponsive={unresponsiveCards(detail).length > 0} paused={paused} />
    </LeaderSection> : null}
  </View>;
}

function LeaderCards({ s, detail, now }: { s:Styles; detail:LeaderDetail; now:number }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(()=>new Set());
  const groups = groupLeaderCards(detail.cards);
  return <View style={{gap:12}}>{leaderCardGroups().map(({key,label})=>{
    const cards = groups[key], open = expanded.has(key);
    return <View key={key} style={{gap:4}}>
      <Text style={[s.muted,{fontWeight:"600"}]}>{label} · {t("leader.ui.cardCount", { count: cards.length })}</Text>
      {cards.length === 0 ? <Text style={s.muted}>{t("leader.ui.none")}</Text> : cards.slice(0,open ? undefined : 5).map(card=>{
        const stuck = Boolean(card.unresponsive) && card.status === "acceptance";
        const tone = stuck ? "red" : acceptanceTone(card,now);
        return <View key={card.id} style={[s.item,{gap:2}]}>
          <Text style={tone === "red" ? s.red : tone === "yellow" ? s.yellow : s.text}>{card.code} · {card.title}</Text>
          {stuck ? <Text style={s.red}>{`${t("leader.ui.unresponsive")} · ${repeatWakeLabel(card)}`}</Text> : null}
          <Text style={tone === "red" ? s.red : tone === "yellow" ? s.yellow : s.muted}>{t("leader.ui.inStateFor", { elapsed: elapsedLabel(card.since,now) })}</Text>
          {card.status === "blocked" ? <Text style={s.muted}>{card.reason.slice(0,80) || t("leader.ui.noBlockReason")}</Text> : null}
        </View>;
      })}
      {cards.length > 5 ? <Pressable accessibilityRole="button" accessibilityState={{expanded:open}} accessibilityLabel={open ? t("leader.ui.collapseGroup", { label }) : t("leader.ui.expandGroup", { label, count: cards.length })} style={pressed([s.ghost,{alignSelf:"flex-start"}])} onPress={()=>setExpanded(prev=>{const next=new Set(prev);if(open)next.delete(key);else next.add(key);return next;})}><Text style={s.ghostText}>{open ? t("leader.ui.collapse") : t("leader.ui.moreCards", { count: cards.length-5 })}</Text></Pressable> : null}
    </View>;
  })}</View>;
}
