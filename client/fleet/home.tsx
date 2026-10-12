import { useRpc } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rankAlerts, splitAlerts } from "../../shared/fleet/alert-groups";
import { type BoardSnapshot, compatCheckRpc } from "../../shared/fleet/board";
import { clipError } from "../../shared/fleet/clip-error";
import { t } from "../../shared/fleet/i18n";
import { homeCounts, homeStatusLine, homeStatusTone } from "../../shared/fleet/home-status";
import { companyHeadline, decisionSummary, homeHeadline, leaderDots, leaderLampKey, statusColorKey, waitingSummary } from "../../shared/fleet/home-summary";
import { kanbanInstalled } from "../../shared/fleet/kanban-presence";
import { isPausedProject } from "../../shared/fleet/paused";
import { leaderSummary } from "../../shared/fleet/leader-panel";
import { panelAttention, panelTabLabel, type PanelTab } from "../../shared/fleet/panel-tabs";
import { splitRecentChoices } from "../../shared/fleet/decision-change";
import { unregisteredDecisions } from "../../shared/fleet/decisions-view";
import { isUnownedDecision } from "../../shared/fleet/unowned-decisions";
import { Decisions } from "./decisions";
import { LeaderBlock } from "./home-leaders";
import { RoleBlock } from "./home-roles";
import { TokenBlock } from "./home-tokens";
import { Fold, Nums, OpenRow, type OpenAgent, pressed, ResponsiveGrid, StatusDot, type Styles } from "./ui";

export function Home({ s, data, onNavigate }: { s: Styles; data: BoardSnapshot; onNavigate: (tab: PanelTab) => void }) {
  const counts = homeCounts(data);
  const tone = homeStatusTone(counts);
  return (
    <View style={{ gap: s.compact ? 8 : 12 }}>
      <HomeBanner s={s} banner={data.home.banner} />
      <HomeHeadline s={s} tone={tone} line={homeHeadline(homeStatusLine(counts))} />
      <HomeGrid s={s} data={data} counts={counts} onNavigate={onNavigate} />
    </View>
  );
}

function HomeBanner({ s, banner }: { s: Styles; banner: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!banner) return null;
  return (
    <Pressable accessibilityRole={s.compact ? "button" : undefined} accessibilityLabel={s.compact ? t(open ? "home.banner.collapseLabel" : "home.banner.expandLabel", { banner }) : undefined} accessibilityState={{ expanded: open }} aria-expanded={s.compact ? open : undefined} disabled={!s.compact} onPress={() => setOpen((value) => !value)} style={pressed([s.card, { padding: s.compact ? 12 : 16, minHeight: 44 }])}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[s.text, { flex: 1 }]} numberOfLines={s.compact && !open ? 1 : undefined}>{banner}</Text>
        {s.compact ? <Text style={s.blue}>{open ? t("home.collapse") : t("home.expand")}</Text> : null}
      </View>
    </Pressable>
  );
}

function HomeHeadline({ s, tone, line }: { s: Styles; tone: "danger" | "warning" | "success"; line: string }) {
  const key = statusColorKey(tone);
  const color = key === "red" ? s.p.red : key === "amber" ? s.p.amber : s.p.green;
  return (
    <View style={[s.card, { padding: s.compact ? 12 : 16 }]}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ marginTop: 8 }}><StatusDot color={color} /></View>
        <View style={{ flex: 1 }}><Nums style={s.text}>{line}</Nums></View>
      </View>
    </View>
  );
}

function HomeGrid({ s, data, counts, onNavigate }: {
  s: Styles; data: BoardSnapshot; counts: ReturnType<typeof homeCounts>; onNavigate: (tab: PanelTab) => void;
}) {
  const attention = panelAttention(data);
  return (
    <ResponsiveGrid s={s} rowGap={s.compact ? 8 : 16}>
      {kanbanInstalled(data.kanban) ? (
        <SummaryCard s={s} title={t("home.card.waiting")} tab="leader" onNavigate={onNavigate} inline>
          <Text style={[s.text, { fontWeight: "600", color: attention.blocking ? s.p.red : s.p.text }]}>{waitingSummary(data.kanban.available, attention.waitingCards)}</Text>
        </SummaryCard>
      ) : null}
      <SummaryCard s={s} title={t("home.card.decisions")} tab="leader" onNavigate={onNavigate} inline>
        <Text style={[s.text, { fontWeight: "600" }]}>{decisionSummary(attention.decisions, counts.unread)}</Text>
      </SummaryCard>
      <SummaryCard s={s} title={t("home.card.quota")} tab="quota" onNavigate={onNavigate}>
        <CompanyLines s={s} companies={data.home.companies} />
      </SummaryCard>
      <SummaryCard s={s} title={t("home.card.leaders")} tab="leader" onNavigate={onNavigate}>
        <LeaderDots s={s} data={data} />
      </SummaryCard>
    </ResponsiveGrid>
  );
}

function SummaryCard({ s, title, tab, onNavigate, inline, children }: {
  s: Styles; title: string; tab: PanelTab; onNavigate: (tab: PanelTab) => void; inline?: boolean; children: React.ReactNode;
}) {
  const row = inline && s.compact ? { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const } : null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={t("home.card.a11y", { title, tab: panelTabLabel(tab) })} style={pressed([s.card, { padding: s.compact ? 8 : 12, gap: s.compact ? 4 : 8, minHeight: 64 }, row])} onPress={() => onNavigate(tab)}>
      <Text style={s.muted}>{title}</Text>
      {children}
    </Pressable>
  );
}

function CompanyLines({ s, companies }: { s: Styles; companies: BoardSnapshot["home"]["companies"] }) {
  return (
    <View style={{ gap: 2 }}>
      {companies.length === 0 ? <Text style={s.text}>{t("home.noQuota")}</Text> : null}
      {companies.map((company) => <Text key={company.id} style={s.secondary} numberOfLines={1}>{companyHeadline(company)}</Text>)}
    </View>
  );
}

function LeaderDots({ s, data }: { s: Styles; data: BoardSnapshot }) {
  const dots = leaderDots(data.supervisorPanel.rows, (project) => isPausedProject(project, data.pausedProjects));
  return (
    <View style={s.row}>
      {data.supervisorPanel.rows.length === 0 ? <Text style={s.text}>{t("home.noLeaders")}</Text> : null}
      {dots.map((dot) => <LeaderDot key={dot.project} s={s} dot={dot} />)}
    </View>
  );
}

function LeaderDot({ s, dot }: { s: Styles; dot: ReturnType<typeof leaderDots>[number] }) {
  const key = leaderLampKey(dot.paused, dot.lamp);
  const color = key === "red" ? s.p.red : key === "amber" ? s.p.amber : key === "green" ? s.p.green : s.p.hint;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }} accessibilityLabel={dot.a11y}>
      <StatusDot color={color} />
      <Text style={s.secondary}>{dot.label}</Text>
    </View>
  );
}

export function LeaderTab({ s, data, openAgent }: { s: Styles; data: BoardSnapshot; openAgent: OpenAgent }) {
  const [shiftLine, setShiftLine] = useState<string | null>(null);
  const summary = leaderSummary(data.supervisorPanel.rows, data.supervisorPanel.details ?? [], data.decisions, data.pausedProjects);
  const unregistered = unregisteredDecisions(data.decisions, data.supervisorPanel.rows.map((row) => row.project), isUnownedDecision);
  const unregisteredChoices = splitRecentChoices(data.recentChoices ?? [], data.supervisorPanel.rows.map((row) => row.project), (project) => isPausedProject(project, data.pausedProjects)).unregistered;
  return (
    <View style={{ gap: 24 }}>
      <Text style={s.h2}>{t("home.leader.summary", { waiting: summary.waitingLeaders, acceptance: summary.acceptance, blocked: summary.blocked }) + (summary.unresponsiveLeaders > 0 ? t("home.leader.unresponsive", { count: summary.unresponsiveLeaders }) : "")}</Text>
      {shiftLine ? <Text style={s.yellow}>{shiftLine}</Text> : null}
      <LeaderBlock s={s} data={data} openAgent={openAgent} onShiftLine={setShiftLine} />
      <Decisions s={s} data={{ ...data, decisions: unregistered, recentChoices: unregisteredChoices }} openAgent={openAgent} showSettings={false} sectionTitle={t("home.unregistered")} />
      <Alerts s={s} data={data} openAgent={openAgent} />
    </View>
  );
}

export function UsageTab({ s, data, onNavigate }: { s: Styles; data: BoardSnapshot; onNavigate?: (tab: PanelTab) => void }) {
  return (
    <View style={{ gap: 24 }}>
      <TokenBlock s={s} days={data.home.days} shares={data.home.roleShares} />
      <RoleBlock s={s} cards={data.home.roleCards} onManage={onNavigate ? () => onNavigate("roles") : undefined} />
    </View>
  );
}

function Alerts({ s, data, openAgent }: { s: Styles; data: BoardSnapshot; openAgent: OpenAgent }) {
  const groups = useMemo(() => splitAlerts(rankAlerts(data.alerts)), [data.alerts]);
  return (
    <View style={{ gap: 10 }}>
      {groups.reds.length === 0 && groups.login.length === 0 ? <Text style={s.green}>{t("home.alerts.none")}</Text> : null}
      {groups.login.map((alert, index) => <AlertText key={`login-${index}`} s={s} kindStyle={s.yellow} alert={alert} />)}
      {groups.reds.map((alert, index) => <AlertRow key={`${alert.kind}-${index}`} s={s} kindStyle={s.red} alert={alert} openAgent={openAgent} />)}
      {groups.rest.length > 0 ? <RestAlerts s={s} alerts={groups.rest} openAgent={openAgent} /> : null}
      <CompatButton s={s} />
    </View>
  );
}

function RestAlerts({ s, alerts, openAgent }: { s: Styles; alerts: BoardSnapshot["alerts"]; openAgent: OpenAgent }) {
  return (
    <Fold s={s} title={t("home.alerts.other")} summary={t("board.warnings.count", { count: alerts.length })}>
      {alerts.map((alert, index) => <AlertRow key={`${alert.kind}-rest-${index}`} s={s} kindStyle={alert.level === "yellow" ? s.yellow : s.muted} alert={alert} openAgent={openAgent} />)}
    </Fold>
  );
}

function AlertBody({ s, kindStyle, alert }: { s: Styles; kindStyle: object; alert: BoardSnapshot["alerts"][number] }) {
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={kindStyle}>{alert.kind}</Text>
      <Text style={s.text}>{alert.text}</Text>
    </View>
  );
}

function AlertText({ s, kindStyle, alert }: { s: Styles; kindStyle: object; alert: BoardSnapshot["alerts"][number] }) {
  return (
    <View style={[s.between, s.item]}>
      <AlertBody s={s} kindStyle={kindStyle} alert={alert} />
    </View>
  );
}

function AlertRow({ s, kindStyle, alert, openAgent }: { s: Styles; kindStyle: object; alert: BoardSnapshot["alerts"][number]; openAgent: OpenAgent }) {
  return (
    <View style={[s.between, s.item]}>
      <AlertBody s={s} kindStyle={kindStyle} alert={alert} />
      <OpenRow s={s} row={alert} openAgent={openAgent} />
    </View>
  );
}

function CompatButton({ s }: { s: Styles }) {
  const run = useRpc(compatCheckRpc);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const onPress = () => {
    setBusy(true);
    setMsg(null);
    run({}).then((result) => setMsg(result.message)).catch((error: unknown) => setMsg(clipError(error, 160))).finally(() => setBusy(false));
  };
  return (
    <View style={{ alignItems: "flex-start", gap: 4 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("home.compat.check")} disabled={busy} style={pressed(s.ghost)} onPress={onPress}>
        <Text style={s.ghostText}>{busy ? t("home.compat.starting") : t("home.compat.check")}</Text>
      </Pressable>
      {msg ? <Text style={s.muted}>{msg}</Text> : null}
    </View>
  );
}
