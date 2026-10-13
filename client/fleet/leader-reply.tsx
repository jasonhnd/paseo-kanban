import { useRpc } from "../rpc";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { leaderReplyRpc } from "../../shared/fleet/board";
import { language, t } from "../../shared/fleet/i18n";
import { acceptanceReminder, delegationReminder, LEADER_REPLY_LIMIT, statusRequest, validateLeaderReply, type LeaderDetail } from "../../shared/fleet/leader-panel";
import { pressed, type Styles } from "./ui";

type Notice = { ok: boolean; text: string };
type Cards = LeaderDetail["cards"];

/** One send path for every box and shortcut on a <leader>: same validation, same RPC, same notice. */
export function useLeaderSend(project: string) {
  const reply = useRpc(leaderReplyRpc);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const send = (body: string, onSent?: () => void) => {
    const error = validateLeaderReply({ project, text: body });
    if (error) { setNotice({ ok: false, text: error }); return; }
    setBusy(true);
    setNotice(null);
    reply({ project, text: body }).then((result) => {
      const time = result.sentAt ? new Date(result.sentAt).toLocaleTimeString(language(), { hour12: false }) : "";
      setNotice({ ok: result.ok, text: result.ok ? t("leader.ui.sentAt", { time }) : result.message });
      if (result.ok) onSent?.();
    }).catch((error: unknown) => setNotice({ ok: false, text: t("leader.server.sendFailed", { error: String(error).slice(0, 200) }) })).finally(() => setBusy(false));
  };
  return { send, busy, notice };
}
type LeaderSend = ReturnType<typeof useLeaderSend>;

export function SendNotice({ s, notice }: { s: Styles; notice: Notice | null }) {
  return notice ? <Text style={notice.ok ? s.green : s.red}>{notice.text}</Text> : null;
}

export function RemindAcceptance({ s, cards, sender, strong }: { s: Styles; cards: Cards; sender: LeaderSend; strong?: boolean }) {
  const any = cards.some((c) => c.status === "acceptance");
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={t("leader.ui.remindAcceptanceA11y")} disabled={sender.busy || !any} style={pressed([strong ? s.button : s.ghost, !any ? { opacity: 0.5 } : null])} onPress={() => sender.send(acceptanceReminder(cards))}>
      <Text style={strong ? s.buttonText : s.ghostText}>{t("leader.ui.remindAcceptance")}</Text>
    </Pressable>
  );
}

export function DelegationReminderAction({ s, project }: { s: Styles; project: string }) {
  const sender = useLeaderSend(project);
  return (
    <View style={{ gap: 6, alignItems: "flex-start" }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("leader.ui.remindDelegation")} disabled={sender.busy} style={pressed(s.ghost)} onPress={() => sender.send(delegationReminder())}>
        <Text style={s.ghostText}>{t("leader.ui.remindDelegation")}</Text>
      </Pressable>
      <SendNotice s={s} notice={sender.notice} />
    </View>
  );
}

/** Always-on reply line of the compact card: one input, send, and the two shortcuts. */
export function LeaderQuickReply({ s, project, cards, unresponsive }: { s: Styles; project: string; cards: Cards; unresponsive: boolean }) {
  const sender = useLeaderSend(project);
  const [text, setText] = useState("");
  const submit = () => sender.send(text, () => setText(""));
  return (
    <View style={{ gap: 6 }}>
      <View style={s.row}>
        <View style={[s.row, { flexWrap: "nowrap", flexGrow: 1, flexBasis: 212, minWidth: 0 }]}>
          <TextInput selectionColor={s.p.blue} cursorColor={s.p.text}
            accessibilityLabel={`${project} · ${t("leader.ui.writeToLeader")}`}
            editable={!sender.busy}
            value={text}
            onChangeText={setText}
            onSubmitEditing={submit}
            returnKeyType="send"
            placeholder={t("leader.ui.writeToIt")}
            placeholderTextColor={s.p.hint}
            style={[s.ghost, s.text, { flex: 1, minWidth: 0, minHeight: 44 }]}
          />
          <Pressable accessibilityRole="button" accessibilityLabel={t("leader.ui.sendToA11y", { project })} disabled={sender.busy} style={pressed(s.button)} onPress={submit}>
            <Text style={s.buttonText}>{sender.busy ? t("leader.ui.sending") : t("leader.ui.send")}</Text>
          </Pressable>
        </View>
        <View style={[s.row, { flexWrap: "nowrap" }]}>
          <RemindAcceptance s={s} cards={cards} sender={sender} strong={unresponsive} />
          <Pressable accessibilityRole="button" accessibilityLabel={t("leader.ui.statusRequestA11y")} disabled={sender.busy} style={pressed(s.ghost)} onPress={() => sender.send(statusRequest())}>
            <Text style={s.ghostText}>{t("leader.ui.statusRequest")}</Text>
          </Pressable>
        </View>
      </View>
      {text.length > LEADER_REPLY_LIMIT ? <Text style={s.red}>{t("leader.ui.countTooLong", { count: text.length, limit: LEADER_REPLY_LIMIT })}</Text> : null}
      <SendNotice s={s} notice={sender.notice} />
    </View>
  );
}

/** The long box, kept where a card has no compact reply line (paused projects, replies to one asked question). */
export function LeaderReplyBox({ s, project, label = t("leader.ui.writeToLeader"), cards, unresponsive = false, paused = false }: {
  s: Styles; project: string; label?: string; cards?: Cards; unresponsive?: boolean; paused?: boolean;
}) {
  const sender = useLeaderSend(project);
  const [text, setText] = useState("");
  return (
    <View style={{ gap: 8 }}>
      {paused ? <Text style={s.yellow}>{t("leader.ui.pausedCanSend")}</Text> : null}
      {cards ? (
        <View style={s.row}>
          <RemindAcceptance s={s} cards={cards} sender={sender} strong={unresponsive} />
          <Pressable accessibilityRole="button" accessibilityLabel={t("leader.ui.remindDelegation")} disabled={sender.busy} style={pressed(s.ghost)} onPress={() => sender.send(delegationReminder())}>
            <Text style={s.ghostText}>{t("leader.ui.remindDelegation")}</Text>
          </Pressable>
        </View>
      ) : null}
      <TextInput selectionColor={s.p.blue} cursorColor={s.p.text} accessibilityLabel={`${project} · ${label}`} multiline editable={!sender.busy} value={text} onChangeText={setText} placeholder={label} placeholderTextColor={s.p.hint} style={[s.ghost, s.text, { minHeight: 72, textAlignVertical: "top" }]} />
      <View style={s.between}>
        <Text style={text.length > LEADER_REPLY_LIMIT ? s.red : s.muted}>{t("leader.ui.count", { count: text.length, limit: LEADER_REPLY_LIMIT })}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t("leader.ui.sendToA11y", { project })} disabled={sender.busy} style={pressed(s.button)} onPress={() => sender.send(text, () => setText(""))}>
          <Text style={s.buttonText}>{sender.busy ? t("leader.ui.sending") : t("leader.ui.send")}</Text>
        </Pressable>
      </View>
      <SendNotice s={s} notice={sender.notice} />
    </View>
  );
}
