import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { CompanyCard, CompanyWindow } from "../../shared/fleet/quota-companies";
import { companyRemainingText, resetPhrase } from "../../shared/fleet/quota-companies";
import { t, tAll } from "../../shared/fleet/i18n";
import { ANTIGRAVITY_CLI, CURSOR_API } from "../../shared/fleet/quota-adapters";
import { AntigravityQuota } from "./antigravity-quota";
import { remainingMarker } from "../../shared/fleet/quota-line";
import { COMPANY_COLUMNS, COMPANY_MIN_CELL_WIDTH, COMPANY_TILE_COLUMNS, COMPANY_TILE_MIN_CELL_WIDTH, companyDispatchSummary } from "../../shared/fleet/quota-tiles";
import { Badge, Metric, Nums, pressed, ResponsiveGrid, Section, type Styles, type Tone, Track } from "./ui";

const TONE = { green: "green", yellow: "amber", red: "red", muted: "hint" } as const;

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** The card's big figure, from its remaining percent (same rounding as the headline). */
function companyFigure(company: CompanyCard): string {
  return companyRemainingText(company.remainingPct);
}

/** Case-insensitive: the badge may be a sentence start ("Paused") or a mid-sentence phrase ("paused until …"). */
function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

/** Dispatch badge colour. The text may come from a cached snapshot in another language. */
function dispatchTone(text: string): Tone {
  if (startsWithAny(text, tAll("quota.companies.dispatchable"))) return "green";
  if (startsWithAny(text, tAll("quota.companies.paused")) || tAll("quota.companies.stopped").includes(text)) return "red";
  return "neutral";
}

function looksUnread(sourceText: string): boolean {
  const lower = sourceText.toLowerCase();
  return tAll("quota.companies.unreadMarker").some((marker) => lower.includes(marker.toLowerCase()));
}

function WindowRow({ s, row, showPace, now, markerBasis }: { s: Styles; row: CompanyWindow; showPace: boolean; now: number; markerBasis: "used" | "remaining" }) {
  const left = row.remainingPct === null ? 0 : clamp(row.remainingPct);
  const fill = s.c[TONE[row.tone]];
  const reset = resetPhrase(row.resetsAt, now);
  const stale = looksUnread(row.sourceText);
  const markAt = (usedAxis: number) => markerBasis === "remaining" ? remainingMarker(usedAxis) : clamp(usedAxis);
  return (
    <View style={{ gap: 4 }}>
      <View style={s.between}>
        <Text style={[s.text, { flex: 1 }]}>{row.name}</Text>
        <Nums style={[s.num, { fontWeight: "600" }]}>
          {row.amountText && row.remainingPct === null ? row.amountText : companyRemainingText(row.remainingPct)}
        </Nums>
      </View>
      <Track
        s={s}
        pct={row.remainingPct === null ? 0 : left}
        color={row.remainingPct === null ? s.p.track : fill}
        markers={[
          ...(showPace && row.showPace && row.pacePct !== null ? [{ at: markAt(row.pacePct), color: s.p.text }] : []),
          ...(showPace && row.showPace && row.stopPct !== null ? [{ at: markAt(row.stopPct), color: s.p.red }] : []),
        ]}
      />
      {reset ? <Nums style={s.muted}>{reset}</Nums> : null}
      {row.amountText && row.remainingPct !== null ? <Nums style={s.muted}>{row.amountText}</Nums> : null}
      <Text style={s.muted}>{t("quota.home.who", { who: row.who })}</Text>
      <View style={s.row}>
        <Text style={s.muted}>{t("quota.home.dispatch")}</Text>
        <Badge s={s} label={row.dispatchText} tone={dispatchTone(row.dispatchText)} />
      </View>
      <Text style={stale ? s.yellow : s.muted}>{row.sourceText}</Text>
    </View>
  );
}

type CardsProps = { s: Styles; companies: CompanyCard[]; showPace: boolean; now: number; cursorFooter?: ReactNode; markerBasis?: "used" | "remaining" };

function CompanyDetail({ s, company, showPace, now, cursorFooter, markerBasis = "used" }: Omit<CardsProps, "companies"> & { company: CompanyCard }) {
  if (company.adapter === ANTIGRAVITY_CLI) return <AntigravityQuota s={s} company={company} now={now} />;
  return (
    <Metric s={s} value={companyFigure(company)} label={company.name}>
      {company.stale ? <Text style={s.yellow}>{t("quota.companies.source.stale")}</Text> : null}
      {company.notice ? <Text style={company.noticeMuted ? s.muted : s.yellow}>{company.notice}</Text> : null}
      {company.couponLine ? <Text style={s.text}>{company.couponLine}</Text> : null}
      {company.couponPlan ? <Text style={s.muted}>{company.couponPlan}</Text> : null}
      {company.creditsLine ? <Text style={s.text}>{company.creditsLine}</Text> : null}
      <View style={{ gap: 12 }}>
        {company.windows.map((row) => (
          <WindowRow key={row.id} s={s} row={row} showPace={showPace} now={now} markerBasis={markerBasis} />
        ))}
      </View>
      {company.adapter === CURSOR_API ? cursorFooter : null}
    </Metric>
  );
}

/** Phone: a 2x2 of small tiles (remaining + dispatch state); tap one to open its detail below. */
function CompanyTiles(props: CardsProps) {
  const { s, companies } = props;
  const [openId, setOpenId] = useState<string | null>(null);
  const open = companies.find((company) => company.id === openId);
  return (
    <View style={{ gap: 12 }}>
      <ResponsiveGrid s={s} columns={COMPANY_TILE_COLUMNS} minCellWidth={COMPANY_TILE_MIN_CELL_WIDTH} rowGap={12}>
        {companies.map((company) => (
          <CompanyTile key={company.id} s={s} company={company} active={company.id === openId} onPress={() => setOpenId(company.id === openId ? null : company.id)} />
        ))}
      </ResponsiveGrid>
      {open ? <CompanyDetail {...props} company={open} /> : <Text style={s.muted}>{t("quota.home.tapForDetail")}</Text>}
    </View>
  );
}

function CompanyTile({ s, company, active, onPress }: { s: Styles; company: CompanyCard; active: boolean; onPress: () => void }) {
  const summary = companyDispatchSummary(company);
  const pct = company.remainingPct === null ? 0 : clamp(company.remainingPct);
  const first = company.windows[0];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: active }}
      accessibilityLabel={t(active ? "quota.home.tileA11yCollapse" : "quota.home.tileA11yExpand", { name: company.name, figure: companyFigure(company), summary })}
      style={pressed([s.metric, { minHeight: 88, padding: 12, gap: 6, borderColor: active ? s.p.blue : s.p.border }])}
      onPress={onPress}
    >
      <Text style={s.metricLabel} numberOfLines={1}>{company.name}</Text>
      <Nums style={[s.metricValue, { fontSize: 20, lineHeight: 24 }]}>{companyFigure(company)}</Nums>
      <Track s={s} pct={pct} color={company.remainingPct === null || !first ? s.p.track : s.c[TONE[first.tone]]} />
      <View style={s.row}>
        <Badge s={s} label={summary} tone={dispatchTone(summary)} />
        {company.stale ? <Text style={s.yellow}>{t("quota.home.oldNumbers")}</Text> : null}
      </View>
    </Pressable>
  );
}

export function CompanyCards(props: CardsProps) {
  const { s, companies } = props;
  if (companies.length === 0) return <Text style={s.muted}>{t("quota.home.noCompanies")}</Text>;
  if (s.compact) {
    const regular = companies.filter((company) => company.adapter !== ANTIGRAVITY_CLI);
    return <View style={{ gap: 12 }}>
      {regular.length > 0 ? <CompanyTiles {...props} companies={regular} /> : null}
      {companies.filter((company) => company.adapter === ANTIGRAVITY_CLI).map((company) => <AntigravityQuota key={company.id} s={s} company={company} now={props.now} />)}
    </View>;
  }
  return (
    <ResponsiveGrid s={s} columns={COMPANY_COLUMNS} minCellWidth={COMPANY_MIN_CELL_WIDTH}>
      {companies.map((company) => <CompanyDetail key={company.id} {...props} company={company} />)}
    </ResponsiveGrid>
  );
}

export function QuotaBlock({ s, companies }: { s: Styles; companies: CompanyCard[] }) {
  return (
    <Section s={s} title={t("quota.home.title")} hint={t("quota.home.barHint")}>
      <Text style={s.muted}>{t("quota.home.markerHint")}</Text>
      <CompanyCards s={s} companies={companies} showPace markerBasis="remaining" now={Date.now()} />
    </Section>
  );
}
