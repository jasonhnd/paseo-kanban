import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { DISPATCH_ROLES, DISPATCH_TIERS, type DispatchSettingRow } from "../../shared/fleet/dispatch-overrides";
import { dispatchSlotLabel } from "../../shared/fleet/dispatch-slots";
import { roleLabel } from "../../shared/fleet/dispatch";
import { t } from "../../shared/fleet/i18n";
import type { Styles } from "./ui";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function DispatchSettings({ s, rows, value, onChange }: { s: Styles; rows: DispatchSettingRow[]; value: unknown; onChange: (value: unknown) => void }) {
  const [role, setRole] = useState<string>("executor");
  const [tier, setTier] = useState<string>("L1");
  const overrides = object(value);
  const action = (label: string, press: () => void, selected = false, disabled = false, accessibilityLabel = label) =>
    <Pressable key={accessibilityLabel} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={press} style={[s.ghost, { opacity: disabled ? 0.5 : 1, borderWidth: selected ? 2 : 0 }]}><Text style={s.ghostText}>{label}</Text></Pressable>;
  const patch = (row: DispatchSettingRow, key?: "effort" | "order", next?: unknown) => {
    const roleRows = { ...object(overrides[row.role]) };
    const tierRows = { ...object(roleRows[row.tier]) };
    const slot = { ...object(tierRows[row.slot]) };
    if (key && next !== undefined) slot[key] = next;
    else if (key) delete slot[key];
    else for (const key of Object.keys(slot)) delete slot[key];
    if (Object.keys(slot).length) tierRows[row.slot] = slot; else delete tierRows[row.slot];
    if (Object.keys(tierRows).length) roleRows[row.tier] = tierRows; else delete roleRows[row.tier];
    const result = { ...overrides };
    if (Object.keys(roleRows).length) result[row.role] = roleRows; else delete result[row.role];
    onChange(result);
  };
  return <View style={{ gap: 8 }} testID="dispatch-settings">
    <Text style={s.h2}>{t("settings.dispatch.title")}</Text>
    <Text style={s.muted}>{t("settings.dispatch.hint")}</Text>
    <View style={[s.row, { flexWrap: "wrap" }]}>{DISPATCH_ROLES.map(key => action(roleLabel(key) ?? key, () => setRole(key), role === key))}</View>
    <View style={s.row}>{DISPATCH_TIERS.map(key => action(t("settings.dispatch.tier", { tier: key }), () => setTier(key), tier === key))}</View>
    {rows.filter(row => row.role === role && row.tier === tier).map(row => {
      const saved = object(object(object(overrides[row.role])[row.tier])[row.slot]);
      const slot = dispatchSlotLabel(row.slot) ?? row.slot;
      const target = t("settings.dispatch.target", { slot, tier: row.tier });
      return <View key={row.slot} testID={`dispatch-row-${row.slot}`} style={{ gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderColor: s.p.border }}>
        <Text style={s.text}>{t("settings.dispatch.profile", { slot, profile: row.profile ?? t("settings.dispatch.missing") })}</Text>
        <Text style={s.muted}>{t("settings.dispatch.defaults", { values: row.defaults.map(item => t("settings.dispatch.defaultValue", {
          context: item.context ? item.context.split("/").at(-1) ?? "" : t("settings.dispatch.all"), effort: item.effort ?? t("settings.dispatch.inherit"), order: item.order,
        })).join("; ") })}</Text>
        {!row.capabilityKnown ? <Text style={s.muted}>{t("settings.dispatch.unknown")}</Text> : null}
        {saved.effort !== undefined ? <Text style={s.muted}>{t("settings.dispatch.savedEffort", { effort: String(saved.effort ?? t("settings.dispatch.inherit")) })}</Text> : null}
        <View style={[s.row, { flexWrap: "wrap" }]}>
          {action(t("settings.dispatch.default"), () => patch(row, "effort"), saved.effort === undefined, false, t("settings.dispatch.defaultAction", { target }))}
          {action(t("settings.dispatch.inherit"), () => patch(row, "effort", null), saved.effort === null, !row.profile, t("settings.dispatch.inheritAction", { target }))}
          {row.supportedEfforts.map(effort => action(t("settings.dispatch.effort", { effort }), () => patch(row, "effort", effort), saved.effort === effort, !row.profile, t("settings.dispatch.effortAction", { target, effort })))}
        </View>
        <Text style={s.muted}>{t("settings.dispatch.order")}</Text>
        <TextInput placeholderTextColor={s.p.hint} selectionColor={s.p.blue} cursorColor={s.p.text} accessibilityLabel={t("settings.dispatch.orderAction", { target })} keyboardType="numeric" value={String(saved.order ?? "")} onChangeText={text => patch(row, "order", text.trim() === "" ? undefined : Number(text))} style={[s.text, { padding: 8, borderWidth: 1, borderColor: s.p.border, borderRadius: 6 }]} />
        {action(t("settings.dispatch.clearRow"), () => patch(row), false, false, t("settings.dispatch.clearAction", { target }))}
      </View>;
    })}
    {rows.length === 0 ? <Text style={s.muted}>{t("settings.dispatch.empty")}</Text> : null}
    {action(t("settings.dispatch.clearAll"), () => onChange({}))}
  </View>;
}
