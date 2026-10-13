import { useRpc } from "../rpc";
import { useQueryClient } from "@tanstack/react-query";
import { useQuery } from "../query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { clipError } from "../../shared/fleet/clip-error";
import { t } from "../../shared/fleet/i18n";
import { priorityLine } from "../../shared/fleet/dispatch-priority";
import { ANTIGRAVITY_CLI, poolCatalog, poolNames } from "../../shared/fleet/quota-adapters";
import { quotaPageReason } from "../../shared/fleet/quota-line";
import {
  axisMax,
  effortCostLine,
  modelMeta,
  PERIOD_LABEL,
  periodSpendLabel,
  planFeeSentence,
  pricesFootnote,
  quotaPageCompanies,
  sharePct,
  tierDispatchLine,
  tokenLine,
  usageRefetchMs,
} from "../../shared/fleet/quota-page";
import { boardUsageRpc, resetCouponsRefreshRpc, type BoardUsage, type Period } from "../../shared/fleet/usage";
import { CompanyCards } from "./home-quota";
import { Bar, ClaudeWho, CursorLinkButtons, fmtUsd, PaceTable, PlanCard } from "./quota-plans";
import { Chip, Empty, fmtTokens, Metric, pressed, ResponsiveGrid, Section, type Styles, timeAgo } from "./ui";

function useQuotaPage() {
  const [period, setPeriod] = useState<Period>("7d");
  const usageRpc = useRpc(boardUsageRpc);
  const refreshCoupons = useRpc(resetCouponsRefreshRpc);
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["afc", "usage", period],
    queryFn: () => usageRpc({ period }),
    refetchInterval: (query) => usageRefetchMs(query.state.data),
  });
  const recheck = () => {
    setConfirming(true);
    setConfirmMsg(null);
    refreshCoupons({})
      .then((result) => {
        setConfirmMsg(result.message);
        void client.invalidateQueries({ queryKey: ["afc", "usage"] });
      })
      .catch((error: unknown) => setConfirmMsg(clipError(error, 160)))
      .finally(() => setConfirming(false));
  };
  return { period, setPeriod, q, confirming, confirmMsg, recheck };
}

export function Quota({ s, antigravityInSummary = false }: { s: Styles; antigravityInSummary?: boolean }) {
  const page = useQuotaPage();
  if (page.q.isError) return <Text style={s.red}>{t("quota.ui.loadFailed", { error: String(page.q.error) })}</Text>;
  const data = page.q.data;
  if (!data) return <Empty s={s} text={t("quota.ui.counting")} />;
  return (
    <View style={{ gap: 28 }}>
      <PeriodRow s={s} period={page.period} data={data} onPick={page.setPeriod} />
      {data.warnings.map((warning) => <Text key={warning} style={s.muted}>ⓘ {warning}</Text>)}
      <CompanySection s={s} data={data} antigravityInSummary={antigravityInSummary} confirming={page.confirming} message={page.confirmMsg} onRecheck={page.recheck} />
      <QuotaGrid s={s} data={data} period={page.period} />
      <Text style={s.muted}>{pricesFootnote(data.pricesAt)}</Text>
    </View>
  );
}

function PeriodRow({ s, period, data, onPick }: { s: Styles; period: Period; data: BoardUsage; onPick: (period: Period) => void }) {
  const stamp = data.scanning ? t("quota.ui.scanning") : data.scannedAt ? t("quota.ui.countedAt", { ago: timeAgo(data.scannedAt) }) : "";
  return (
    <View style={s.row}>
      {(Object.keys(PERIOD_LABEL) as Period[]).map((item) => (
        <Chip key={item} s={s} label={PERIOD_LABEL[item]} active={item === period} onPress={() => onPick(item)} />
      ))}
      <Text style={s.muted}>{stamp}</Text>
      <Text style={s.muted}>{t("quota.ui.panelUpdatedAt", { ago: timeAgo(data.generatedAt) })}</Text>
    </View>
  );
}

function CompanySection({ s, data, antigravityInSummary, confirming, message, onRecheck }: {
  s: Styles; data: BoardUsage; antigravityInSummary: boolean; confirming: boolean; message: string | null; onRecheck: () => void;
}) {
  const companies = (data.companies ?? []).filter(company => !antigravityInSummary || company.adapter !== ANTIGRAVITY_CLI);
  if (companies.length === 0 && antigravityInSummary) return null;
  return (
    <Section s={s} title={t("quota.ui.companiesTitle")} hint={t("quota.ui.companiesHint")}>
      <Text style={s.muted}>{t("quota.home.markerHint")}</Text>
      <CompanyCards
        s={s}
        companies={quotaPageCompanies(companies, quotaPageReason)}
        showPace
        markerBasis="remaining"
        now={Date.now()}
        cursorFooter={<CursorLinkButtons s={s} link={data.cursorLink} />}
      />
      <CouponRecheck s={s} confirming={confirming} message={message} onPress={onRecheck} />
    </Section>
  );
}

function CouponRecheck({ s, confirming, message, onPress }: { s: Styles; confirming: boolean; message: string | null; onPress: () => void }) {
  return (
    <View style={{ alignItems: "flex-start", gap: 4 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("quota.ui.recheckCouponsA11y")} disabled={confirming} style={pressed(s.ghost)} onPress={onPress}>
        <Text style={s.ghostText}>{confirming ? t("quota.ui.rechecking") : t("quota.ui.recheck")}</Text>
      </Pressable>
      {message ? <Text style={s.muted}>{message}</Text> : null}
    </View>
  );
}

function QuotaGrid({ s, data, period }: { s: Styles; data: BoardUsage; period: Period }) {
  const priority = priorityLine(data.priority, poolNames(poolCatalog(data.plans), "short"));
  return (
    <ResponsiveGrid s={s}>
      <SpendMetric s={s} data={data} period={period} />
      <Section s={s} title={t("quota.ui.paceTitle")} hint={t("quota.ui.paceHint")}>
        {priority ? <Text style={s.text}>{priority}</Text> : null}
        <PaceTable s={s} pools={data.pools ?? {}} plans={data.plans} />
      </Section>
      <TierSection s={s} dispatch={data.dispatch} />
      <CostSection s={s} dispatch={data.dispatch} />
      <Section s={s} title={t("quota.ui.claudeWhoTitle")} hint={t("quota.ui.claudeWhoHint")}>
        <ClaudeWho s={s} spend={data.dispatch?.claude ?? null} />
      </Section>
      <PlansSection s={s} data={data} />
      <ModelSection s={s} data={data} period={period} />
      <RoleSection s={s} data={data} />
    </ResponsiveGrid>
  );
}

function SpendMetric({ s, data, period }: { s: Styles; data: BoardUsage; period: Period }) {
  return (
    <Metric s={s} value={fmtUsd(data.totals.apiUsd)} label={periodSpendLabel(period)}>
      <Text style={s.text}>{planFeeSentence(data.totals.planUsd, data.totals.apiUsd)}</Text>
      <Text style={[s.muted, { fontVariant: ["tabular-nums"] }]}>{tokenLine(data.totals.tokens, fmtTokens)}</Text>
    </Metric>
  );
}

function TierSection({ s, dispatch }: { s: Styles; dispatch: BoardUsage["dispatch"] }) {
  return (
    <Section s={s} title={t("quota.ui.tierTitle")} hint={t("quota.ui.tierHint")}>
      {!dispatch ? <Empty s={s} text={t("quota.plans.notEnoughData")} /> : null}
      {dispatch?.tiers.map((row) => <Text key={row.tier} style={s.text}>{tierDispatchLine(row)}</Text>)}
    </Section>
  );
}

function CostSection({ s, dispatch }: { s: Styles; dispatch: BoardUsage["dispatch"] }) {
  const rows = dispatch?.costs ?? [];
  return (
    <Section s={s} title={t("quota.ui.costTitle")} hint={t("quota.ui.costHint")}>
      {!dispatch || rows.length === 0 ? <Empty s={s} text={t("quota.plans.notEnoughData")} /> : null}
      {rows.map((row) => <Text key={`${row.profile}\0${row.effort}`} style={s.text}>{effortCostLine(row, fmtTokens)}</Text>)}
    </Section>
  );
}

function PlansSection({ s, data }: { s: Styles; data: BoardUsage }) {
  const plans = data.plans.filter(plan => plan.adapter !== ANTIGRAVITY_CLI);
  if (plans.length === 0) return null;
  return (
    <Section s={s} title={t("quota.ui.plansTitle")} hint={t("quota.ui.plansHint")}>
      <ResponsiveGrid s={s}>
        {plans.map((plan) => <PlanCard key={plan.id} s={s} plan={plan} pools={data.pools ?? {}} />)}
      </ResponsiveGrid>
    </Section>
  );
}

function ModelSection({ s, data, period }: { s: Styles; data: BoardUsage; period: Period }) {
  const max = axisMax(data.byModel.map((row) => row.apiUsd ?? 0));
  return (
    <Section s={s} title={t("quota.ui.byModel")} hint={PERIOD_LABEL[period]}>
      {data.byModel.length === 0 ? <Empty s={s} text={t("quota.ui.noUsage")} /> : null}
      {data.byModel.map((row) => <ModelRow key={row.model} s={s} row={row} max={max} />)}
    </Section>
  );
}

function ModelRow({ s, row, max }: { s: Styles; row: BoardUsage["byModel"][number]; max: number }) {
  return (
    <View style={[s.item, { gap: 3 }]}>
      <View style={s.between}>
        <Text style={[s.mono, { flex: 1 }]}>{row.model}</Text>
        <Text style={[s.num, { fontWeight: "600" }]} numberOfLines={1}>{fmtUsd(row.apiUsd)}</Text>
      </View>
      <Bar s={s} pct={sharePct(row.apiUsd ?? 0, max)} />
      <Text style={s.muted}>{modelMeta(row.plan, tokenLine(row.tokens, fmtTokens), row.apiUsd === null)}</Text>
    </View>
  );
}

function RoleSection({ s, data }: { s: Styles; data: BoardUsage }) {
  const max = axisMax(data.byRole.map((row) => row.apiUsd));
  return (
    <Section s={s} title={t("quota.ui.byRole")} hint={t("quota.ui.byRoleHint")}>
      {data.byRole.map((row) => <RoleRow key={row.role} s={s} row={row} max={max} />)}
    </Section>
  );
}

function RoleRow({ s, row, max }: { s: Styles; row: BoardUsage["byRole"][number]; max: number }) {
  return (
    <View style={[s.item, { gap: 3 }]}>
      <View style={s.between}>
        <Text style={[s.text, { flex: 1 }]}>{row.role}</Text>
        <Text style={[s.num, { fontWeight: "600" }]} numberOfLines={1}>{fmtUsd(row.apiUsd)}</Text>
      </View>
      <Bar s={s} pct={sharePct(row.apiUsd, max)} />
      <Text style={s.muted}>{tokenLine(row.tokens, fmtTokens)}</Text>
    </View>
  );
}
