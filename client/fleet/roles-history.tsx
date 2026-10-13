import { useRpc } from "../rpc";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { displayProfileName } from "../../shared/fleet/dispatch";
import { t } from "../../shared/fleet/i18n";
import { changeText, type HistoryView, modelSpecText, rolesUndoRpc } from "../../shared/fleet/roles-history";
import { Badge, Fold, pressed, timeAgo, type Styles } from "./ui";

/** History under a role card: swaps made from this page, newest first, each with Undo when it still applies. */
export function RoleHistory({ s, rows, onChanged }: { s: Styles; rows: HistoryView[]; onChanged: () => void }) {
  if (rows.length === 0) return <Text style={s.muted}>{t("roles.historyUi.none")}</Text>;
  return (
    <Fold s={s} title={t("roles.historyUi.title")} summary={t("roles.historyUi.count", { count: rows.length })}>
      {rows.map((row) => <HistoryRow key={row.id} s={s} row={row} onChanged={onChanged} />)}
    </Fold>
  );
}

function HistoryRow({ s, row, onChanged }: { s: Styles; row: HistoryView; onChanged: () => void }) {
  const name = displayProfileName(row.profile);
  return (
    <View style={[s.item, { gap: 4 }]}>
      <View style={[s.row, { flexWrap: "wrap" }]}>
        <Text style={[s.muted, { fontVariant: ["tabular-nums"] }]}>{timeAgo(row.at)}</Text>
        <Text style={[s.text, { fontWeight: "600", flexShrink: 1 }]}>{row.undoOf ? t("roles.historyUi.undoOf", { name }) : name}</Text>
        {row.undoneAt ? <Badge s={s} label={t("roles.historyUi.undone")} tone="neutral" /> : null}
      </View>
      <Text style={s.mono}>{changeText(row)}</Text>
      {row.undoBlock === null ? <UndoButton s={s} row={row} name={name} onChanged={onChanged} /> : null}
      {row.undoBlock !== null && !row.undoneAt ? <Text style={s.muted}>{row.undoBlock}</Text> : null}
    </View>
  );
}

function UndoButton({ s, row, name, onChanged }: { s: Styles; row: HistoryView; name: string; onChanged: () => void }) {
  const undo = useRpc(rolesUndoRpc);
  const [confirming, setConfirming] = useState(false);
  const run = useMutation({ mutationFn: undo, onSuccess: (result) => { if (result.ok) onChanged(); } });
  if (run.data?.ok) return <Text style={s.green}>✓ {run.data.message}</Text>;
  return (
    <View style={{ gap: 6 }}>
      {confirming ? (
        <View style={[s.card, { gap: 8, borderColor: s.p.amber }]} accessibilityRole="alert">
          <Text style={s.text}>{t("roles.historyUi.confirmQuestion", { name, spec: modelSpecText(row.from) })}</Text>
          <Text style={s.muted}>{t("roles.historyUi.confirmNote")}</Text>
          <View style={s.row}>
            <Pressable accessibilityRole="button" accessibilityLabel={t("roles.historyUi.confirm")} disabled={run.isPending} style={pressed(s.button)} onPress={() => run.mutate({ id: row.id })}>
              <Text style={s.buttonText}>{run.isPending ? t("roles.historyUi.undoing") : t("roles.historyUi.confirm")}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t("roles.historyUi.cancelLabel")} disabled={run.isPending} style={pressed(s.ghost)} onPress={() => { setConfirming(false); run.reset(); }}>
              <Text style={s.ghostText}>{t("roles.historyUi.cancel")}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={t("roles.historyUi.undoLabel", { name })} style={pressed([s.ghost, { alignSelf: "flex-start" }])} onPress={() => setConfirming(true)}>
          <Text style={s.ghostText}>{t("roles.historyUi.undo")}</Text>
        </Pressable>
      )}
      {run.data && !run.data.ok ? <Text style={s.red}>{t("roles.historyUi.failed", { message: run.data.message })}</Text> : null}
      {run.isError ? <Text style={s.red}>{t("roles.historyUi.failed", { message: String(run.error) })}</Text> : null}
    </View>
  );
}
