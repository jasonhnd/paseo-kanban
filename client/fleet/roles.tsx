import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { BoardModel } from "../../shared/fleet/board";
import { t } from "../../shared/fleet/i18n";
import { type RoleCardView, type RoleRowView, rolesPageRpc, rolesSetRpc } from "../../shared/fleet/roles-page";
import { pickableCompanies, routeSuffix } from "../../shared/fleet/roles-policy";
import { chosenModel, choiceReady, confirmText, diffLines, modelConflicts, initialChoice, modelLabel, modelsOf, pickCompany, pickModel, sameAsCurrent, type SwapChoice } from "../../shared/fleet/roles-swap";
import { RoleHistory } from "./roles-history";
import { Badge, Chip, Empty, ResponsiveGrid, Section, pressed, type Styles } from "./ui";

const ROLES_REFRESH_MS = 30_000;
const ROLES_KEY = ["afc", "roles"] as const;

export function RolesTab({ s, models }: { s: Styles; models: BoardModel[] | undefined }) {
  const read = useRpc(rolesPageRpc);
  const page = useQuery({ queryKey: ROLES_KEY, queryFn: () => read({}), refetchInterval: ROLES_REFRESH_MS });
  return (
    <Section s={s} title={t("roles.tab.title")} hint={t("roles.tab.hint")}>
      {page.isError ? <Text style={s.red}>{t("roles.tab.readFailed", { error: String(page.error) })}</Text> : null}
      {!page.data && !page.isError ? <Empty s={s} text={t("roles.tab.loading")} /> : null}
      {page.data?.warnings.map((warning) => <Text key={warning} style={s.yellow}>ⓘ {warning}</Text>)}
      {page.data ? (
        <ResponsiveGrid s={s} minCellWidth={300}>
          {page.data.cards.map((card) => <RoleCard key={card.key} s={s} card={card} cards={page.data.cards} models={models} />)}
        </ResponsiveGrid>
      ) : null}
      {models === undefined ? <Text style={s.muted}>{t("roles.tab.modelsLoading")}</Text> : null}
    </Section>
  );
}

function RoleCard({ s, card, cards, models }: { s: Styles; card: RoleCardView; cards: RoleCardView[]; models: BoardModel[] | undefined }) {
  const queryClient = useQueryClient();
  return (
    <View style={s.card}>
      <View style={[s.between, { alignItems: "flex-start" }]}>
        <Text style={s.h2}>{card.label}</Text>
        <Text style={s.muted}>{t("roles.tab.profiles", { count: card.rows.length })}</Text>
      </View>
      {card.rows.length === 0 ? <Empty s={s} text={t("roles.tab.noProfiles")} /> : null}
      {card.rows.map((row) => <RoleRow key={row.profile} s={s} roleKey={card.key} row={row} cards={cards} models={models} />)}
      {card.orderLines.map((line) => <Text key={line} style={s.muted}>{line}</Text>)}
      <RoleHistory s={s} rows={card.history} onChanged={() => void queryClient.invalidateQueries({ queryKey: ROLES_KEY })} />
    </View>
  );
}

function RoleRow({ s, roleKey, row, cards, models }: { s: Styles; roleKey: string; row: RoleRowView; cards: RoleCardView[]; models: BoardModel[] | undefined }) {
  const [open, setOpen] = useState(false);
  const tone = row.status === "paused" ? "red" : row.status === "prefer" ? "blue" : "green";
  return (
    <View style={s.item}>
      <View style={[s.between, { alignItems: "flex-start" }]}>
        <View style={{ flexShrink: 1, flexGrow: 1, gap: 4, minWidth: 0 }}>
          <View style={s.row}>
            <Text style={[s.text, { fontWeight: "600" }]}>{row.name}</Text>
            {row.isMain ? <Badge s={s} label={t("roles.tab.mainProfile")} tone="neutral" /> : null}
          </View>
          <Text style={s.text}>{t("roles.tab.quota", { quota: row.quota })}<Text style={s.mono}>{modelLabel(models, row.provider, row.model)}</Text>{row.thinking ? t("roles.tab.thinking", { thinking: row.thinking }) : ""}</Text>
          <Text style={[s.muted, { fontVariant: ["tabular-nums"] }]}>{t("roles.tab.runs", { week: row.weekTasks, today: row.todayRuns, pool: row.pool })}</Text>
          <View style={s.row}>
            <Badge s={s} label={t(row.status === "paused" ? "roles.tab.paused" : row.status === "prefer" ? "roles.tab.prefer" : "roles.tab.ready")} tone={tone} />
            {row.status !== "ready" || row.statusText !== t("dispatch.status.ready") ? <Text style={[s.muted, { flexShrink: 1 }]}>{row.statusText}</Text> : null}
          </View>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={t("roles.tab.swapLabel", { name: row.name })} accessibilityState={{ expanded: open }} style={pressed([s.ghost, { minWidth: 44, alignItems: "center" }])} onPress={() => setOpen(!open)}>
          <Text style={s.ghostText}>{open ? t("roles.tab.collapse") : t("roles.tab.swap")}</Text>
        </Pressable>
      </View>
      {open ? <SwapForm s={s} roleKey={roleKey} row={row} cards={cards} models={models ?? []} onDone={() => setOpen(false)} /> : null}
    </View>
  );
}

function SwapForm({ s, roleKey, row, cards, models, onDone }: { s: Styles; roleKey: string; row: RoleRowView; cards: RoleCardView[]; models: BoardModel[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const setRole = useRpc(rolesSetRpc);
  const [choice, setChoice] = useState<SwapChoice>(() => initialChoice(row, models));
  const [confirming, setConfirming] = useState(false);
  const swap = useMutation({
    mutationFn: setRole,
    onSuccess: (result) => { if (result.ok) void queryClient.invalidateQueries({ queryKey: ROLES_KEY }); },
  });
  const model = chosenModel(models, choice);
  const choices = modelsOf(models, choice.company);
  const edit = (next: SwapChoice) => { setChoice(next); setConfirming(false); swap.reset(); };
  const ready = choiceReady(model, choice) && !sameAsCurrent(row, choice);
  if (swap.data?.ok) return <SwapDone s={s} result={swap.data} onDone={onDone} />;
  return (
    <View style={[s.card, { gap: 10, backgroundColor: s.p.raised }]}>
      <Text style={s.muted}>{t("roles.tab.stepCompany")}</Text>
      <View style={s.row}>
        {pickableCompanies(models).map((company) => <Chip key={company} s={s} label={company} active={choice.company === company} onPress={() => edit(pickCompany(company))} />)}
      </View>
      {models.length === 0 ? <Empty s={s} text={t("roles.tab.noModels")} /> : null}
      {choice.company ? <Text style={s.muted}>{t("roles.tab.stepModel")}</Text> : null}
      <View style={s.row}>
        {choices.map((item) => <Chip key={`${item.provider}/${item.id}`} s={s} label={`${item.label || item.id}${routeSuffix(item.provider)}`} active={choice.provider === item.provider && choice.modelId === item.id} onPress={() => edit(pickModel(choice, item))} />)}
      </View>
      {model && model.thinking.length > 0 ? <Text style={s.muted}>{t("roles.tab.stepThinking")}</Text> : null}
      <View style={s.row}>
        {(model?.thinking ?? []).map((level) => <Chip key={level} s={s} label={level} active={choice.thinking === level} onPress={() => edit({ ...choice, thinking: level })} />)}
      </View>
      {ready && !confirming ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("roles.tab.nextLabel")} style={pressed([s.button, { alignSelf: "flex-start" }])} onPress={() => setConfirming(true)}>
          <Text style={s.buttonText}>{t("roles.tab.next")}</Text>
        </Pressable>
      ) : null}
      {ready && confirming ? <ConfirmBox s={s} row={row} choice={choice} warnings={modelConflicts(cards, roleKey, row.profile, choice.modelId ?? "")} pending={swap.isPending} onCancel={() => setConfirming(false)} onConfirm={() => swap.mutate({ profile: row.profile, provider: choice.provider ?? "", model: choice.modelId ?? "", thinking: choice.thinking })} /> : null}
      {swap.data && !swap.data.ok ? <Text style={s.red}>{t("roles.tab.notSwapped", { message: swap.data.message })}</Text> : null}
      {swap.isError ? <Text style={s.red}>{t("roles.tab.notSwapped", { message: String(swap.error) })}</Text> : null}
    </View>
  );
}

function ConfirmBox({ s, row, choice, warnings, pending, onCancel, onConfirm }: { s: Styles; row: RoleRowView; choice: SwapChoice; warnings: string[]; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <View style={[s.card, { gap: 8, borderColor: s.p.amber }]} accessibilityRole="alert">
      <Text style={s.text}>{confirmText(row.name, row, choice)}</Text>
      {warnings.map((line) => <Text key={line} style={s.yellow}>⚠ {line}</Text>)}
      <Text style={s.muted}>{t("roles.tab.confirmNote")}</Text>
      <View style={s.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("roles.tab.confirmLabel")} disabled={pending} style={pressed(s.button)} onPress={onConfirm}>
          <Text style={s.buttonText}>{pending ? t("roles.tab.switching") : t("roles.tab.confirm")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t("roles.tab.cancel")} disabled={pending} style={pressed(s.ghost)} onPress={onCancel}>
          <Text style={s.ghostText}>{t("roles.tab.cancel")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SwapDone({ s, result, onDone }: { s: Styles; result: { message: string; before: string | null; after: string | null }; onDone: () => void }) {
  return (
    <View style={[s.card, { gap: 6, backgroundColor: s.p.raised }]}>
      <Text style={s.green}>✓ {result.message}</Text>
      {diffLines(result).map((line) => <Text key={line} style={s.text}>{line}</Text>)}
      <Pressable accessibilityRole="button" accessibilityLabel={t("roles.tab.close")} style={pressed([s.ghost, { alignSelf: "flex-start" }])} onPress={onDone}>
        <Text style={s.ghostText}>{t("roles.tab.close")}</Text>
      </Pressable>
    </View>
  );
}
