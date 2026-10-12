import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { DEFAULT_LEADER_THRESHOLDS } from "../../shared/fleet/leader-usage";
import { configReadRpc, configWriteRpc, type SettingsFile, type SettingsSnapshot } from "../../shared/fleet/settings";
import { ADAPTER_IDS, ANTIGRAVITY_CLI, CURSOR_API, KEYCHAIN, OPTIONAL_ADAPTERS, providerOf } from "../../shared/fleet/quota-adapters";
import { CYCLE_KINDS } from "../../shared/fleet/quota-cycle";
import { LANGUAGE_SETTINGS, language, t, type MessageKey } from "../../shared/fleet/i18n";
import { adoptSettingsLanguage } from "./settings-language";
import { useStyles, type Styles } from "./ui";
import { RoleOnboarding } from "./onboarding";
import { DispatchSettings } from "./dispatch-settings";
import { DEFAULT_OPS_PROJECT } from "../../shared/fleet/ops-project";

type Read = (input: { file: SettingsFile }) => Promise<SettingsSnapshot>;
type Write = (input: { file: SettingsFile; document: Record<string, unknown>; revision: string }) => Promise<{ status: "saved" | "conflict"; snapshot: SettingsSnapshot }>;
export function FleetSettings({ theme, layout, integrated = false }: PluginSurfaceProps & { integrated?: boolean }) {
  const read = useRpc(configReadRpc);
  const write = useRpc(configWriteRpc);
  const [, setLang] = useState(language());
  const s = useStyles(theme, layout);
  return <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <Text style={s.h2}>{t("settings.title")}</Text>
    <Text style={s.muted}>{t("settings.intro")}</Text>
    <RoleOnboarding s={s} />
    <SettingsEditor s={s} file="config" integrated={integrated} read={read} write={write} onLanguage={setLang} />
    <SettingsEditor s={s} file="plans" read={read} write={write} onLanguage={setLang} />
  </ScrollView>;
}
function Action({ s, label, onPress, disabled = false }: { s: Styles; label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} accessibilityState={{ disabled }} onPress={onPress} style={[s.ghost, { opacity: disabled ? 0.5 : 1 }]}><Text style={s.ghostText}>{label}</Text></Pressable>;
}
function Field({ s, label, value, onChange }: { s: Styles; label: string; value: string; onChange: (value: string) => void }) {
  return <View style={{ gap: 4, minWidth: 130, flexGrow: 1 }}><Text style={s.muted}>{label}</Text><TextInput placeholderTextColor={s.p.hint} selectionColor={s.p.blue} cursorColor={s.p.text} accessibilityLabel={label} value={value} onChangeText={onChange} style={[s.text, { borderWidth: 1, borderColor: s.p.border, borderRadius: 6, padding: 8 }]} /></View>;
}
function Toggle({ s, label, value, onChange }: { s: Styles; label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Pressable accessibilityRole="switch" accessibilityLabel={label} aria-checked={value} accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={s.ghost}><Text style={s.ghostText}>{label}: {value ? t("settings.on") : t("settings.off")}</Text></Pressable>;
}
const list = (value: unknown) => Array.isArray(value) ? value.join(", ") : "";
const terms = (value: string) => value.split(",").map(term => term.trim()).filter(Boolean);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Each file has its own revision and save action, so a conflict cannot partially save another section. */
export function SettingsEditor({ s, file, read, write, onLanguage, integrated = false }: { integrated?: boolean; s: Styles; file: SettingsFile; read: Read; write: Write; onLanguage?: (language: SettingsSnapshot["language"]) => void }) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [provider, setProvider] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<MessageKey | null>(null);
  const [error, setError] = useState("");
  const accept = (next: SettingsSnapshot) => { setSnapshot(next); setDraft(next.document); setProvider(""); adoptSettingsLanguage(next.language); onLanguage?.(next.language); };
  const load = async () => {
    setBusy(true); setError(""); setMessage(null);
    try { accept(await read({ file })); } catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [file]);
  const save = async () => {
    if (!snapshot) return;
    setBusy(true); setError(""); setMessage(null);
    try {
      const result = await write({ file, revision: snapshot.revision, document: draft });
      if (result.status === "saved") { accept(result.snapshot); setMessage("settings.saved"); }
      else setMessage("settings.conflict");
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  const patch = (key: string, value: unknown) => setDraft(current => ({ ...current, [key]: value }));
  const plans = Array.isArray(draft.plans) ? draft.plans.map(object) : [];
  const planUpdate = (index: number, changes: Record<string, unknown>) => {
    const next = plans.map((row, i) => i === index ? { ...row, ...changes } : row);
    const oldId = plans[index]?.id;
    setDraft(current => ({ ...current, plans: next, ...(changes.id !== undefined && changes.id !== oldId && current.dispatchPriority ? { dispatchPriority: { ...object(current.dispatchPriority), order: (object(current.dispatchPriority).order as unknown[] ?? []).map(id => id === oldId ? changes.id : id) } } : {}) }));
  };
  const planPatch = (index: number, key: string, value: unknown) => planUpdate(index, { [key]: value });
  const removePlan = (index: number) => {
    const next = plans.filter((_, i) => i !== index);
    const order = (Array.isArray(priority.order) ? priority.order : []).filter(id => next.some(row => row.id === id));
    setDraft(current => ({ ...current, plans: next, dispatchPriority: order.length ? { ...priority, order } : null }));
  };
  const priority = object(draft.dispatchPriority);
  const bannedProviders = Array.isArray(draft.bannedProviders) ? draft.bannedProviders.filter((value): value is string => typeof value === "string") : [];
  return <View style={s.card}>
    <Text style={s.h2}>{t(file === "config" ? "settings.general" : "settings.plans")}</Text>
    {!snapshot ? <Text style={s.muted}>{t("settings.loading")}</Text> : file === "config" ? <>
      <Field s={s} label={t("settings.opsProject")} value={typeof draft.opsProject === "string" ? draft.opsProject : DEFAULT_OPS_PROJECT} onChange={value => patch("opsProject", value.trim() ? value : undefined)} />
      <Text style={s.muted}>{t("settings.opsProjectHint")}</Text>
      <Text style={s.h2}>{t("settings.leaderUsage")}</Text>
      <Text style={s.muted}>{t("settings.leaderUsageHint")}</Text>
      <View style={s.row}>{(["reminderTokens", "warningTokens"] as const).map(key => <Field key={key} s={s} label={t(`settings.leaderUsage.${key}`)} value={String(object(draft.leaderUsage)[key] ?? DEFAULT_LEADER_THRESHOLDS[key])} onChange={value => patch("leaderUsage", { ...DEFAULT_LEADER_THRESHOLDS, ...object(draft.leaderUsage), [key]: value.trim() ? Number(value) : 0 })} />)}</View>
      {!integrated ? <><Text style={s.muted}>{t("settings.language")}</Text>
      <View style={s.row}>{LANGUAGE_SETTINGS.map(value => <Action key={value} s={s} label={t(`settings.lang.${value}`)} onPress={() => patch("language", value)} disabled={(draft.language ?? "system") === value} />)}</View></> : null}
      <Field s={s} label={t("settings.hidden")} value={list(draft.hiddenPlans)} onChange={value => patch("hiddenPlans", terms(value))} />
      <Text style={s.muted}>{t("settings.hiddenHint")}</Text>
      <Text style={s.h2}>{t("settings.banned")}</Text>
      <Text style={s.muted}>{t("settings.bannedHint")}</Text>
      {bannedProviders.map((value, index) => <View key={index} style={s.row}>
        <Text style={s.text}>{value}</Text>
        <Action s={s} label={t("settings.removeProvider", { provider: value })} onPress={() => patch("bannedProviders", bannedProviders.filter((_, i) => i !== index))} />
      </View>)}
      <Field s={s} label={t("settings.provider")} value={provider} onChange={setProvider} />
      <Action s={s} label={t("settings.addProvider")} disabled={!provider.trim() || bannedProviders.includes(provider.trim())} onPress={() => { patch("bannedProviders", [...bannedProviders, provider.trim()]); setProvider(""); }} />
      <Text style={s.muted}>{t("settings.adapters")}</Text>
      {OPTIONAL_ADAPTERS.map(id => <View key={id}>
        <Toggle s={s} label={t(id === CURSOR_API ? "settings.cursor" : id === KEYCHAIN ? "settings.keychain" : "settings.antigravity")} value={typeof object(draft.adapters)[id] === "boolean" ? object(draft.adapters)[id] === true : snapshot.effectiveAdapters?.[id] ?? false} onChange={value => patch("adapters", { ...object(draft.adapters), [id]: value })} />
        {id === ANTIGRAVITY_CLI ? <Text style={s.muted}>{t("settings.antigravityHint")}</Text> : null}
      </View>)}
      <Text style={s.muted}>{t("settings.reloadHint")}</Text>
      <DispatchSettings s={s} rows={snapshot.dispatchRows ?? []} value={draft.dispatchOverrides} onChange={value => patch("dispatchOverrides", value)} />
    </> : <>
      {plans.length === 0 ? <Text style={s.muted}>{t("settings.emptyPools")}</Text> : null}
      {plans.map((row, index) => <View key={index} style={{ gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderColor: s.p.border }}>
        <View style={[s.row, { flexWrap: "wrap" }]}>{(["id", "name", "providers", "priceUsdMonthly", "stopPct", "cycleDay"] as const).map(key => <Field key={key} s={s} label={t(`settings.plan.${key}`)} value={key === "providers" ? list(row[key]) : String(row[key] ?? "")} onChange={value => planPatch(index, key, key === "providers" ? terms(value) : ["priceUsdMonthly", "stopPct", "cycleDay"].includes(key) ? value === "" ? undefined : Number(value) : value)} />)}</View>
        <Text style={s.muted}>{t("settings.plan.adapter")}</Text>
        <View style={[s.row, { flexWrap: "wrap" }]}>{ADAPTER_IDS.map(id => <Action key={id} s={s} label={t("settings.adapterId", { id })} disabled={row.adapter === id} onPress={() => planUpdate(index, id === ANTIGRAVITY_CLI ? { adapter: id, usageProvider: "antigravity", providers: ["antigravity"], dispatch: false, quotaProtection: "pause" } : { adapter: id, ...(id !== "manual" && !row.usageProvider ? { usageProvider: providerOf(id) } : {}) })} />)}</View>
        <Field s={s} label={t("settings.plan.usageProvider")} value={String(row.usageProvider ?? "")} onChange={value => planPatch(index, "usageProvider", value)} />
        <Text style={s.muted}>{t("settings.plan.bindingHint")}</Text>
        <QuotaFields s={s} row={row} update={changes => planUpdate(index, changes)} />
        <Toggle s={s} label={t("settings.plan.dispatch")} value={row.dispatch !== false} onChange={value => planPatch(index, "dispatch", value)} />
        <Toggle s={s} label={t("settings.plan.pacePause")} value={row.pacePause !== false} onChange={value => planPatch(index, "pacePause", value)} />
        <Action s={s} label={t("settings.remove")} onPress={() => removePlan(index)} />
      </View>)}
      <Action s={s} label={t("settings.add")} onPress={() => patch("plans", [...plans, { id: "", name: "", adapter: "manual", providers: [], priceUsdMonthly: null, dispatch: false, stopPct: 80, quotaCycle: { kind: "unknown" }, quotaProtection: "pause" }])} />
      <Text style={s.h2}>{t("settings.priority")}</Text>
      <Text style={s.muted}>{t("settings.priorityHint")}</Text>
      <Field s={s} label={t("settings.order")} value={list(priority.order)} onChange={value => patch("dispatchPriority", { ...priority, order: terms(value) })} />
      <Field s={s} label={t("settings.until")} value={String(priority.until ?? "")} onChange={value => patch("dispatchPriority", { ...priority, until: value })} />
      <Action s={s} label={t("settings.quotaOrder")} onPress={() => patch("dispatchPriority", null)} />
    </>}
    {message ? <Text accessibilityRole="alert" style={s.muted}>{t(message)}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={s.red}>{t("settings.error", { error })}</Text> : null}
    <View style={s.row}><Action s={s} label={t("settings.save")} onPress={() => void save()} disabled={busy || !snapshot} /><Action s={s} label={t("settings.refresh")} onPress={() => void load()} disabled={busy} /></View>
  </View>;
}

function QuotaFields({ s, row, update }: { s: Styles; row: Record<string, unknown>; update: (changes: Record<string, unknown>) => void }) {
  const cycle = object(row.quotaCycle);
  const reading = object(row.manualOverride === undefined ? row.manual : row.manualOverride);
  const setReading = (key: string, value: unknown) => update({ manualOverride: { source: "manual", ttlSeconds: 86400, at: new Date().toISOString(), ...reading, [key]: value } });
  return <>
    {row.adapter === ANTIGRAVITY_CLI ? <>
      <Text style={s.muted}>{t("settings.antigravityBucket")}</Text>
      <View style={[s.row, { flexWrap: "wrap" }]}>{(["gemini", "claude-gpt"] as const).map(bucket => <Action key={bucket} s={s} label={t(bucket === "gemini" ? "settings.bucket.gemini" : "settings.bucket.claudeGpt")} disabled={row.antigravityBucket === bucket} onPress={() => update({ antigravityBucket: bucket, providers: ["antigravity"], usageProvider: "antigravity", dispatch: false, quotaProtection: "pause" })} />)}</View>
      <Text style={s.muted}>{t("settings.antigravityHint")}</Text>
    </> : null}
    <Text style={s.h2}>{t("settings.cycle")}</Text>
    {!cycle.kind ? <Text style={s.muted}>{t("settings.cycle.legacy")}</Text> : null}
    <View style={[s.row, { flexWrap: "wrap" }]}>{CYCLE_KINDS.map(kind => <Action key={kind} s={s} label={t(`settings.cycle.${kind}`)} disabled={cycle.kind === kind} onPress={() => update({ quotaCycle: kind === "unknown" ? { kind } : kind === "duration" ? { kind, seconds: 18000, startsAt: new Date().toISOString() } : { kind, timeZone: typeof cycle.timeZone === "string" ? cycle.timeZone : "UTC", hour: 0, minute: 0, ...(kind === "month" ? { day: 1 } : kind === "week" ? { weekday: 0 } : {}) } })} />)}</View>
    {cycle.kind && cycle.kind !== "unknown" && cycle.kind !== "duration" ? <View style={[s.row, { flexWrap: "wrap" }]}>
      {(["timeZone", "hour", "minute", ...(cycle.kind === "month" ? ["day"] : cycle.kind === "week" ? ["weekday"] : [])]).map(key => <Field key={key} s={s} label={t(key === "day" ? "settings.cycle.dayOfMonth" : `settings.cycle.${key}` as MessageKey)} value={String(cycle[key] ?? "")} onChange={value => update({ quotaCycle: { ...cycle, [key]: key === "timeZone" ? value : Number(value) } })} />)}
    </View> : null}
    {cycle.kind === "duration" ? <View style={s.row}>{(["seconds", "startsAt"] as const).map(key => <Field key={key} s={s} label={t(`settings.cycle.${key}`)} value={String(cycle[key] ?? "")} onChange={value => update({ quotaCycle: { ...cycle, [key]: key === "seconds" ? Number(value) : value } })} />)}</View> : null}
    <Text style={s.muted}>{t("settings.cycle.hint")}</Text>
    <Text style={s.h2}>{t("settings.manual")}</Text>
    <View style={[s.row, { flexWrap: "wrap" }]}>{(["usedPct", "at", "source", "ttlSeconds", "startsAt", "resetsAt"] as const).map(key => <Field key={key} s={s} label={t(`settings.manual.${key}`)} value={String(reading[key] ?? "")} onChange={value => key === "usedPct" && value === "" ? update({ manualOverride: null }) : setReading(key, value === "" ? undefined : key === "usedPct" || key === "ttlSeconds" ? Number(value) : value)} />)}</View>
    <View style={s.row}><Action s={s} label={t("settings.manual.now")} onPress={() => setReading("at", new Date().toISOString())} /><Action s={s} label={t("settings.manual.clear")} onPress={() => update({ manualOverride: null })} /></View>
    <Text style={s.muted}>{t("settings.manual.hint")}</Text>
    <Toggle s={s} label={t("settings.noProtection")} value={row.quotaProtection === "none"} onChange={value => update({ quotaProtection: value ? "none" : "pause" })} />
    {row.quotaProtection === "none" ? <Text style={s.yellow}>{t("settings.noProtectionHint")}</Text> : null}
  </>;
}
