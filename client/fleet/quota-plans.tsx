import { useRpc } from "../rpc";
import { configReadRpc, configWriteRpc } from "../../shared/fleet/settings";
import { CURSOR_API } from "../../shared/fleet/quota-adapters";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { t } from "../../shared/fleet/i18n";
import { paceProgressText, quotaPageReason, remainingFill, remainingMarker, remainingText } from "../../shared/fleet/quota-line";
import {
  claudePaceSentence,
  claudePeriodTitle,
  cursorConnectLabel,
  cursorDemand,
  cursorFailKind,
  cursorManualFailText,
  cursorScreenOffText,
  cursorVia,
  fmtUsd,
  fmtWhen,
  isFirstPoolWindow,
  manualContext,
  manualPreview,
  paceDailyLine,
  paceDaysLine,
  paceName,
  paceTone,
  parseManualPct,
  parseMonthlyPrice,
  planNote,
  poolKey,
  poolLineKind,
  priceButtonLabel,
  priceDraft,
  quotaWindowReadText,
  roiLine,
  showCursorConnect,
  showCursorDisconnect,
  showManualEditor,
  cursorOverCap,
  verdictText,
  windowLabel,
  windowUsageLine,
  windowValueLine,
  type PoolView,
} from "../../shared/fleet/quota-plans-view";
import { cursorBalanceNote, cursorConnectRpc, cursorDisconnectRpc, paceStatusLabel, planUpdateRpc, type BoardUsage, type UsagePlan, type UsageWindow } from "../../shared/fleet/usage";
import { Badge, Empty, pressed, type Styles, Track } from "./ui";
import { isMonthlyWindow } from "../../shared/fleet/quota-adapters";

export { fmtUsd, fmtWhen };

export function Bar({ s, pct, marker, color }: { s: Styles; pct: number; marker?: number | null; color?: string }) {
  const markers = marker !== null && marker !== undefined ? [{ at: marker, color: s.p.text }] : undefined;
  return <Track s={s} pct={pct} color={color ?? s.p.textSecondary} markers={markers} />;
}

export function PlanCard({ s, plan, pools }: { s: Styles; plan: UsagePlan; pools: Record<string, PoolView> }) {
  const note = planNote(plan);
  return (
    <View style={s.card}>
      <View style={s.between}>
        <Text style={[s.h2, { flex: 1 }]}>{plan.name}</Text>
        <PriceEditor s={s} plan={plan} />
      </View>
      {note ? <Text style={note.tone === "yellow" ? s.yellow : s.muted}>{note.text}</Text> : null}
      {plan.windows.map((usageWindow, index) => <PlanWindow key={usageWindow.label} s={s} plan={plan} pools={pools} usageWindow={usageWindow} index={index} />)}
      <Text style={s.text}>{roiLine(plan)}</Text>
      <Text style={s.muted}>{plan.coverage}</Text>
    </View>
  );
}

function PlanWindow({ s, plan, pools, usageWindow, index }: {
  s: Styles; plan: UsagePlan; pools: Record<string, PoolView>; usageWindow: UsageWindow; index: number;
}) {
  const verdict = verdictText(usageWindow);
  const toneStyle = { red: s.red, yellow: s.yellow, green: s.green, muted: s.muted };
  const barColor = usageWindow.verdict === "short" ? s.p.red : usageWindow.verdict === "waste" ? s.p.amber : s.p.green;
  return (
    <View style={[s.item, { gap: 3 }]}>
      <WindowHead s={s} usageWindow={usageWindow} />
      <Text style={s.muted}>{quotaWindowReadText(usageWindow)}</Text>
      {usageWindow.readingState ? <Text style={usageWindow.readingState === "stale" ? s.yellow : s.muted}>{usageWindow.readingState === "stale" ? t("quota.setup.staleReading", { used: usageWindow.staleUsedPct ?? "?", at: usageWindow.sampledAt ?? usageWindow.manualAt ?? "" }) : t("quota.setup.reading", { state: t(`quota.setup.state.${usageWindow.readingState}`), at: usageWindow.sampledAt ?? usageWindow.manualAt ?? "", error: usageWindow.readError ?? "" })}</Text> : null}
      {usageWindow.readingState === "live" && usageWindow.paceEligible === false ? <Text style={s.muted}>{t("quota.setup.liveNoPace", { window: windowLabel(usageWindow.label) })}</Text> : null}
      {usageWindow.usedPct !== null ? <Bar s={s} pct={remainingFill(usageWindow.usedPct)} marker={usageWindow.elapsedPct === null ? null : remainingMarker(usageWindow.elapsedPct)} color={barColor} /> : null}
      {cursorOverCap(plan, usageWindow.usedPct) ? <CursorCap s={s} /> : null}
      {usageWindow.paceEligible !== false ? <Text style={toneStyle[verdict.tone]}>{verdict.text}</Text> : null}
      {plan.cursorRead && (usageWindow.primary || isMonthlyWindow(usageWindow)) ? <CursorBlocks s={s} read={plan.cursorRead} /> : null}
      {usageWindow.balance ? <Text style={s.muted}>{cursorBalanceNote(usageWindow.balance, plan.overageBilling)}</Text> : null}
      <WindowPool s={s} plan={plan} pools={pools} index={index} />
      <Text style={s.muted}>{windowValueLine(usageWindow)}</Text>
      {showManualEditor(usageWindow, plan) ? <ManualPctEditor s={s} plan={plan} usageWindow={usageWindow} /> : null}
    </View>
  );
}

function WindowHead({ s, usageWindow }: { s: Styles; usageWindow: UsageWindow }) {
  return (
    <View style={s.between}>
      <Text style={s.text}>{windowLabel(usageWindow.label)}</Text>
      <Text style={s.muted}>{windowUsageLine(usageWindow)}</Text>
    </View>
  );
}

function CursorCap({ s }: { s: Styles }) {
  return (
    <View style={s.row}>
      <Badge s={s} label={t("quota.plansUi.overCap")} tone="red" />
      <Text style={s.text}>{t("quota.plansUi.cursorCapText")}</Text>
    </View>
  );
}

function WindowPool({ s, plan, pools, index }: {
  s: Styles; plan: UsagePlan; pools: Record<string, PoolView>; index: number;
}) {
  if (!isFirstPoolWindow(plan.windows, plan.id, index)) return null;
  const pool = pools[poolKey(plan.id, plan.windows[index] ?? {})];
  const kind = poolLineKind(pool);
  if (!kind) return null;
  return (
    <View style={{ gap: 4 }}>
      <Badge s={s} label={kind.label} tone={kind.tone} />
      {pool?.reason ? <Text style={s.text}>{quotaPageReason(pool.reason)}</Text> : null}
    </View>
  );
}

export function ClaudeWho({ s, spend }: { s: Styles; spend: NonNullable<BoardUsage["dispatch"]>["claude"] }) {
  if (!spend) return <Empty s={s} text={t("quota.plans.notEnoughData")} />;
  return (
    <View style={{ gap: 8 }}>
      <SpendBlock s={s} title={t("quota.page.period.today")} rows={spend.today} />
      <SpendBlock s={s} title={claudePeriodTitle(spend.resetsAt)} rows={spend.week} />
      {spend.unmatchedDirs.length > 0 ? <Text style={s.muted}>{t("quota.plansUi.unmatchedDirs", { dirs: spend.unmatchedDirs.join(t("quota.companies.listSep")) })}</Text> : null}
      <Text style={s.text}>{claudePaceSentence(spend.projectedPct, spend.dailyCapPct)}</Text>
    </View>
  );
}

function SpendBlock({ s, title, rows }: { s: Styles; title: string; rows: { category: string; usd: number; sharePct: number }[] }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={s.h2}>{title}</Text>
      {rows.map((row) => <Text key={`${title}-${row.category}`} style={s.text}>{row.category} · {fmtUsd(row.usd)} · {row.sharePct}%</Text>)}
    </View>
  );
}

export function PaceTable({ s, pools, plans }: { s: Styles; pools: Record<string, PoolView>; plans: UsagePlan[] }) {
  const rows = Object.entries(pools);
  if (rows.length === 0) return <Empty s={s} text={t("quota.plansUi.noSnapshot")} />;
  return (
    <View style={{ gap: 8 }}>
      {rows.map(([key, pool]) => <PaceRow key={key} s={s} name={paceName(plans, key)} pool={pool} />)}
    </View>
  );
}

function PaceRow({ s, name, pool }: { s: Styles; name: string; pool: PoolView }) {
  return (
    <View style={[s.item, { gap: 2 }]}>
      <View style={s.between}>
        <Text style={s.text}>{name}</Text>
        <Badge s={s} label={paceStatusLabel(pool)} tone={paceTone(pool)} />
      </View>
      <Text style={s.muted}>{paceDaysLine(pool)} · {paceProgressText(pool.usedPct, pool.pacePct)}</Text>
      <Text style={s.muted}>{paceDailyLine(pool)}</Text>
      {pool.earlyReset ? <Text style={s.muted}>{pool.earlyReset}</Text> : null}
    </View>
  );
}

export function CursorLinkButtons({ s, link, monitoring }: { s: Styles; link: BoardUsage["cursorLink"]; monitoring?: boolean }) {
  const readConfig = useRpc(configReadRpc);
  const writeConfig = useRpc(configWriteRpc);
  const connect = useRpc(cursorConnectRpc);
  const disconnect = useRpc(cursorDisconnectRpc);
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const off = monitoring === false;
  const state = off ? "unlinked" : link?.state ?? "unlinked";
  const enable = async () => {
    const snapshot = await readConfig({ file: "config" });
    const document = snapshot.document;
    const adapters = document.adapters && typeof document.adapters === "object" && !Array.isArray(document.adapters) ? document.adapters : {};
    const result = await writeConfig({ file: "config", revision: snapshot.revision,
      document: { ...document, adapters: { ...adapters, [CURSOR_API]: true } } });
    await client.invalidateQueries({ queryKey: ["afc"] });
    return { ok: result.status === "saved", message: t(result.status === "saved" ? "cursor.monitoring.enabled" : "settings.conflict") };
  };
  const run = (action: () => Promise<{ ok: boolean; message: string }>) => runCursorLink(action, setBusy, setNote, client);
  return (
    <View style={{ gap: 6 }}>
      {off ? <>
        <Text style={s.muted}>{t("cursor.monitoring.guide")}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("cursor.monitoring.enable")} disabled={busy} style={pressed(s.button)} onPress={() => run(enable)}>
          <Text style={s.buttonText}>{t("cursor.monitoring.enable")}</Text>
        </Pressable>
      </> : null}
      <CursorLinkRow s={s} state={state} busy={busy} disabled={off} onConnect={() => run(() => connect({}))} onDisconnect={() => run(() => disconnect({}))} />
      {!off && state === "unlinked" && link?.message ? <Text style={s.muted}>{link.message}</Text> : null}
      {note ? <Text style={s.muted}>{note}</Text> : null}
    </View>
  );
}

function runCursorLink(
  action: () => Promise<{ ok: boolean; message: string }>,
  setBusy: (busy: boolean) => void,
  setNote: (note: string | null) => void,
  client: ReturnType<typeof useQueryClient>,
) {
  setBusy(true);
  action()
    .then(async (result) => {
      setNote(result.message);
      await client.invalidateQueries({ queryKey: ["afc", "usage"] });
    })
    .catch((error: unknown) => setNote(String(error).slice(0, 160)))
    .finally(() => setBusy(false));
}

function CursorLinkRow({ s, state, busy, disabled = false, onConnect, onDisconnect }: {
  s: Styles; state: string; busy: boolean; disabled?: boolean; onConnect: () => void; onDisconnect: () => void;
}) {
  return (
    <View style={s.row}>
      {showCursorConnect(state) ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("quota.plans.cursor.connect")} disabled={busy || disabled} style={pressed(s.button)} onPress={onConnect}>
          <Text style={s.buttonText}>{cursorConnectLabel(busy, state)}</Text>
        </Pressable>
      ) : null}
      {showCursorDisconnect(state) ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("quota.plansUi.disconnect")} disabled={busy} style={pressed(s.ghost)} onPress={onDisconnect}>
          <Text style={s.ghostText}>{t("quota.plansUi.disconnect")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function CursorBlocks({ s, read }: { s: Styles; read: NonNullable<UsagePlan["cursorRead"]> }) {
  if (!read.ok) return <CursorReadFailed s={s} read={read} />;
  const when = read.readAt ? fmtWhen(read.readAt) : "";
  return (
    <View style={{ gap: 2 }}>
      <Text style={s.muted}>{t("quota.plansUi.source", { via: cursorVia(read.via), when })}</Text>
      <Text style={s.muted}>{t("quota.plansUi.cursorAuto", { remaining: remainingText(read.autoPct) })}</Text>
      <Text style={s.muted}>{t("quota.plansUi.cursorApi", { remaining: remainingText(read.apiPct), included: remainingText(read.includedPct) })}</Text>
      <Text style={s.muted}>{t("quota.plansUi.onDemand", { amount: cursorDemand(read) })}</Text>
    </View>
  );
}

function CursorReadFailed({ s, read }: { s: Styles; read: NonNullable<UsagePlan["cursorRead"]> }) {
  if (cursorFailKind(read) === "screen-off") return <Text style={s.muted}>{cursorScreenOffText(read.manualAt)}</Text>;
  return <Text style={s.yellow}>{cursorManualFailText(read.manualAt, read.error)}</Text>;
}

function useSavePlan() {
  const update = useRpc(planUpdateRpc);
  const client = useQueryClient();
  return async (input: Parameters<typeof update>[0]) => {
    const result = await update(input);
    await client.invalidateQueries({ queryKey: ["afc", "usage"] });
    return result;
  };
}

function PriceEditor({ s, plan }: { s: Styles; plan: UsagePlan }) {
  const save = useSavePlan();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!editing) return <PriceLabel s={s} plan={plan} onEdit={() => { setValue(priceDraft(plan.priceUsdMonthly)); setEditing(true); }} />;
  return <PriceForm s={s} plan={plan} value={value} error={error} onChange={setValue} onSave={() => saveMonthly(value, plan.id, save, setError, setEditing)} />;
}

function PriceLabel({ s, plan, onEdit }: { s: Styles; plan: UsagePlan; onEdit: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={t("quota.plansUi.editPriceA11y", { name: plan.name })} style={pressed(s.ghost)} onPress={onEdit}>
      <Text style={plan.priceUsdMonthly === null ? s.yellow : s.ghostText}>{priceButtonLabel(plan.priceUsdMonthly)}</Text>
    </Pressable>
  );
}

function PriceForm({ s, plan, value, error, onChange, onSave }: {
  s: Styles; plan: UsagePlan; value: string; error: string | null; onChange: (value: string) => void; onSave: () => void;
}) {
  return (
    <View style={s.row}>
      <TextInput selectionColor={s.p.blue} cursorColor={s.p.text} accessibilityLabel={t("quota.plansUi.priceInputA11y", { name: plan.name })} style={[s.ghost, s.text, { minWidth: 70 }]} value={value} onChangeText={onChange} keyboardType="decimal-pad" placeholder={t("quota.plansUi.pricePlaceholder")} placeholderTextColor={s.p.hint} />
      <Pressable accessibilityRole="button" accessibilityLabel={t("quota.plansUi.savePriceA11y")} style={pressed(s.button)} onPress={onSave}>
        <Text style={s.buttonText}>{t("quota.plansUi.save")}</Text>
      </Pressable>
      {error ? <Text style={s.red}>{error}</Text> : null}
    </View>
  );
}

async function saveMonthly(
  value: string,
  id: string,
  save: (input: { id: string; priceUsdMonthly: number | null }) => Promise<unknown>,
  setError: (error: string | null) => void,
  setEditing: (editing: boolean) => void,
) {
  const parsed = parseMonthlyPrice(value);
  if (!parsed.ok) {
    setError(parsed.error);
    return;
  }
  await save({ id, priceUsdMonthly: parsed.price });
  setError(null);
  setEditing(false);
}

function ManualPctEditor({ s, plan, usageWindow }: { s: Styles; plan: UsagePlan; usageWindow: UsageWindow }) {
  const save = useSavePlan();
  const [value, setValue] = useState("");
  const preview = manualPreview(value);
  return (
    <View style={[s.row, { marginTop: 2 }]}>
      <Text style={s.muted}>{manualContext(plan, usageWindow)}</Text>
      <Text style={s.muted}>{t("quota.plansUi.manualPrompt")}</Text>
      <TextInput selectionColor={s.p.blue} cursorColor={s.p.text} accessibilityLabel={t("quota.plansUi.pctInputA11y", { name: plan.name })} style={[s.ghost, s.text, { minWidth: 56 }]} value={value} onChangeText={setValue} keyboardType="decimal-pad" placeholder="%" placeholderTextColor={s.p.hint} />
      {preview ? <Text style={s.muted}>{preview}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={t("quota.plansUi.savePctA11y")} style={pressed(s.ghost)} onPress={() => saveManual(value, plan.id, save, setValue)}>
        <Text style={s.ghostText}>{t("quota.plansUi.save")}</Text>
      </Pressable>
    </View>
  );
}

async function saveManual(
  value: string,
  id: string,
  save: (input: { id: string; manualUsedPct: number }) => Promise<unknown>,
  setValue: (value: string) => void,
) {
  const parsed = parseManualPct(value);
  if (parsed === null) return;
  await save({ id, manualUsedPct: parsed });
  setValue("");
}
