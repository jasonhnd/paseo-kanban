import { useRpc } from "@getpaseo/plugin/client";
import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { language, t } from "../../shared/fleet/i18n";
import { discoverRolesRpc, previewRolesRpc, type Discovery, type RoleChoice, type RolePreview } from "../../shared/fleet/profile-bootstrap";
import type { Styles } from "./ui";

type Draft = Omit<RoleChoice, "confirmedFamily"> & { confirmedFamily: boolean };
const empty = (): Draft => ({ provider: "", model: "", family: "", confirmedFamily: false });

function Action({ s, label, onPress, disabled = false }: { s: Styles; label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable style={s.ghost} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}><Text style={s.ghostText}>{label}</Text></Pressable>;
}

function Choice({ s, title, discovery, draft, setDraft }: { s: Styles; title: string; discovery: Discovery; draft: Draft; setDraft: (draft: Draft) => void }) {
  const provider = discovery.providers.find(row => row.provider === draft.provider);
  const model = provider?.models.find(row => row.id === draft.model);
  return <View style={{ gap: 8 }}>
    <Text style={s.h2}>{title}</Text>
    {discovery.providers.filter(row => row.state === "discoverable" && row.enabled).map(row => <View key={row.provider}>
      <Text style={s.muted}>{row.provider}</Text>
      <View style={[s.row, { flexWrap: "wrap" }]}>{row.models.map(item => <Action key={item.id} s={s} label={`${row.provider} / ${item.label}`} disabled={draft.provider === row.provider && draft.model === item.id} onPress={() => setDraft({ ...empty(), provider: row.provider, model: item.id })} />)}</View>
    </View>)}
    {model ? <>
      <Text style={s.muted}>{t("onboarding.familyHint")}</Text>
      <TextInput placeholderTextColor={s.p.hint} selectionColor={s.p.blue} cursorColor={s.p.text} style={s.text} accessibilityLabel={t("onboarding.family", { role: title })} value={draft.family} onChangeText={family => setDraft({ ...draft, family, confirmedFamily: false })} />
      <Action s={s} label={t(draft.confirmedFamily ? "onboarding.confirmed" : "onboarding.confirm", { role: title })} disabled={!draft.family.trim()} onPress={() => setDraft({ ...draft, confirmedFamily: !draft.confirmedFamily })} />
      <Text style={s.muted}>{t("onboarding.options")}</Text>
      <View style={[s.row, { flexWrap: "wrap" }]}><Action s={s} label={t("onboarding.defaults", { role: title })} onPress={() => setDraft({ ...draft, modeId: undefined, thinkingOptionId: undefined })} />
        {provider!.modes.map(row => <Action key={row.id} s={s} label={t("onboarding.mode", { role: title, value: row.label })} disabled={draft.modeId === row.id} onPress={() => setDraft({ ...draft, modeId: row.id })} />)}
        {model.thinking.map(row => <Action key={row.id} s={s} label={t("onboarding.thinking", { role: title, value: row.label })} disabled={draft.thinkingOptionId === row.id} onPress={() => setDraft({ ...draft, thinkingOptionId: row.id })} />)}
      </View>
    </> : null}
  </View>;
}

/** A manual setup aid: discovery and preview never apply profiles or change review routing. */
export function RoleOnboarding({ s }: { s: Styles }) {
  const discover = useRpc(discoverRolesRpc);
  const preview = useRpc(previewRolesRpc);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [executor, setExecutor] = useState<Draft>(empty);
  const [reviewer, setReviewer] = useState<Draft>(empty);
  const [includeReviewer, setIncludeReviewer] = useState(false);
  const [result, setResult] = useState<RolePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const revision = useRef(0);
  const clear = () => { revision.current++; setResult(null); setFailed(false); };
  const load = async () => {
    setBusy(true); clear(); setDiscovery(null); setExecutor(empty()); setReviewer(empty()); setIncludeReviewer(false);
    try { setDiscovery(await discover({})); } catch { setFailed(true); } finally { setBusy(false); }
  };
  const generate = async () => {
    if (!executor.confirmedFamily || (includeReviewer && !reviewer.confirmedFamily)) return;
    setBusy(true); clear();
    const requestedRevision = revision.current;
    try {
      const next = await preview({ executor: { ...executor, confirmedFamily: true }, ...(includeReviewer ? { reviewer: { ...reviewer, confirmedFamily: true as const } } : {}), language: language() });
      if (revision.current === requestedRevision) {
        setResult(next);
        if (next.status !== "ready") setDiscovery(null);
      }
    } catch {
      if (revision.current === requestedRevision) { setFailed(true); setDiscovery(null); }
    } finally { setBusy(false); }
  };
  const hasModels = discovery?.providers.some(row => row.enabled && row.state === "discoverable" && row.models.length > 0);
  return <View style={s.card} testID="role-onboarding">
    <Text style={s.h2}>{t("onboarding.title")}</Text>
    <Text style={s.muted}>{t("onboarding.previewOnly")}</Text>
    <Text style={s.muted}>{t("onboarding.privacy")}</Text>
    <Action s={s} label={t("onboarding.discover")} onPress={() => void load()} disabled={busy} />
    {busy ? <Text style={s.muted}>{t("onboarding.loading")}</Text> : null}
    {failed ? <Text accessibilityRole="alert" style={s.red}>{t("onboarding.failed")}</Text> : null}
    {discovery ? <>
      <Text style={s.muted}>{t(`onboarding.status.${discovery.status}`)}</Text>
      <Text style={s.muted}>{t("onboarding.authUnknown")}</Text>
      {discovery.providers.map(row => <Text key={row.provider} style={s.muted}>{row.provider}: {t(`onboarding.provider.${row.state}`)}</Text>)}
      {!hasModels ? <Text style={s.muted}>{t("onboarding.noModels")}</Text> : <>
        <Choice s={s} title={t("onboarding.primary")} discovery={discovery} draft={executor} setDraft={draft => { setExecutor(draft); clear(); }} />
        <Action s={s} label={t(includeReviewer ? "onboarding.removeReviewer" : "onboarding.addReviewer")} onPress={() => { setIncludeReviewer(!includeReviewer); clear(); }} disabled={busy} />
        {includeReviewer ? <Choice s={s} title={t("onboarding.reviewer")} discovery={discovery} draft={reviewer} setDraft={draft => { setReviewer(draft); clear(); }} /> : null}
        <Action s={s} label={t("onboarding.generate")} onPress={() => void generate()} disabled={busy || !executor.confirmedFamily || (includeReviewer && !reviewer.confirmedFamily)} />
      </>}
    </> : null}
    <Text style={s.muted}>{t("onboarding.reviewA")}</Text>
    <Text style={s.muted}>{t("onboarding.reviewB")}</Text>
    <Text style={s.muted}>{t("onboarding.l4")}</Text>
    <Text style={s.muted}>{t("onboarding.noQuota")}</Text>
    {result ? result.status === "ready" ? <>
      <Text style={s.muted}>{t(result.review === "independent" ? "onboarding.independent" : "onboarding.manual")}</Text>
      <Text style={s.muted}>{t("onboarding.copyHint")}</Text>
      <Text selectable style={s.mono} testID="role-preview-json">{JSON.stringify(result.profiles, null, 2)}</Text>
    </> : <Text accessibilityRole="alert" style={s.red}>{t(result.issue === "timeout" || result.issue === "unknown" ? `onboarding.status.${result.issue}` : `onboarding.issue.${result.issue}`)}</Text> : null}
  </View>;
}
