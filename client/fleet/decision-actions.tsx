import { useRpc } from "../rpc";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { changeDecisionRpc, decideReplyRpc } from "../../shared/fleet/board";
import { type CardOption, type ChosenState, chosenLine, confirmLine, parseDecisionCard } from "../../shared/fleet/decision-card";
import { canChangeChoice } from "../../shared/fleet/decision-change";
import { REPLY_CHOICE } from "../../shared/fleet/decisions";
import { replyError } from "../../shared/fleet/decisions-view";
import { t } from "../../shared/fleet/i18n";
import { noLeaderHint } from "../../shared/fleet/unowned-decisions";
import { pressed, type OpenAgent, type Styles } from "./ui";

export interface ReplyMessage {
  ok: boolean;
  text: string;
  /** Set when a letter was recorded, so a list can keep the "picked" card after the row closes. */
  chosen?: ChosenState;
  /** Set when the user closed the item from the panel, so the card can stay and offer undo. */
  panelClosed?: boolean;
  /** Set when that close was undone. */
  panelRestored?: boolean;
}

const BUTTON_MIN_HEIGHT = 56;
const LETTER_BOX = 40;

export function DecisionActions({ s, id, title, detail, onDefer, onResult, allowText = true, initialChosen = null, initialPanelClosed = false }: {
  s: Styles;
  id: string;
  title: string;
  detail: string;
  onDefer?: (id: string) => void;
  onResult?: (message: ReplyMessage) => void;
  /** false for decisions whose project has no <leader>: letters and shelve only. */
  allowText?: boolean;
  initialChosen?: ChosenState | null;
  /** The containing region's current close state, including a reopen read back from another region. */
  initialPanelClosed?: boolean;
}) {
  const card = useMemo(() => parseDecisionCard(title, detail), [title, detail]);
  const reply = useDecisionReply(id, onResult, initialChosen);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [shelving, setShelving] = useState(false);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [panelClosed, setPanelClosed] = useState(initialPanelClosed);
  useEffect(() => { setPanelClosed(initialPanelClosed); }, [initialPanelClosed]);
  const pick = (letter: string) => {
    setConfirming(null);
    reply.send(letter, reply.text);
  };
  const dismiss = () => {
    setConfirmDismiss(false);
    void reply.send(REPLY_CHOICE.dismiss, "").then((result) => { if (result.ok) setPanelClosed(true); });
  };
  if (reply.chosen && !reply.changing) {
    return <ChosenBox s={s} chosen={reply.chosen} busy={reply.busy} msg={reply.msg} canChange={canChangeChoice(reply.chosen.at, Date.now())} onChange={reply.startChange} />;
  }
  if (panelClosed && !reply.changing) {
    return <ClosedBox s={s} busy={reply.busy} msg={reply.msg} onUndo={() => {
      void reply.send(REPLY_CHOICE.restore, "").then((result) => { if (result.ok) setPanelClosed(false); });
    }} />;
  }
  return (
    <View style={{ gap: 12 }}>
      {reply.changing ? <ChangingNote s={s} onBack={reply.cancelChange} /> : null}
      {card.options.length === 0
        ? <MissingOptions s={s} allowText={allowText} busy={reply.busy} onAsk={() => reply.send(REPLY_CHOICE.askOptions, "")} />
        : <OptionList s={s} card={card} busy={reply.busy} confirming={confirming} onAsk={setConfirming} onPick={pick} />}
      {writing ? <CommentBox s={s} reply={reply} hasOptions={card.options.length > 0} /> : null}
      {shelving ? <ShelveConfirm s={s} busy={reply.busy} onYes={() => { setShelving(false); reply.send(REPLY_CHOICE.shelve, ""); }} onNo={() => setShelving(false)} /> : null}
      {confirmDismiss ? <DismissConfirm s={s} busy={reply.busy} onYes={dismiss} onNo={() => setConfirmDismiss(false)} /> : null}
      {reply.msg ? <Text style={reply.msg.ok ? s.green : s.red}>{reply.msg.text}</Text> : null}
      <SecondaryRow
        s={s}
        busy={reply.busy}
        canWrite={allowText}
        writing={writing}
        onWrite={() => setWriting((open) => !open)}
        onDefer={onDefer ? () => onDefer(id) : undefined}
        onShelve={allowText ? undefined : () => { setConfirmDismiss(false); setShelving(true); }}
        onDismiss={() => { setShelving(false); setWriting(false); setConfirmDismiss(true); }}
      />
    </View>
  );
}

function useDecisionReply(id: string, onResult: ((message: ReplyMessage) => void) | undefined, initialChosen: ChosenState | null) {
  const reply = useRpc(decideReplyRpc);
  const change = useRpc(changeDecisionRpc);
  const client = useQueryClient();
  /** After a change the answer lives on a new item; the next change starts from it. */
  const [currentId, setCurrentId] = useState(initialChosen?.id ?? id);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [chosen, setChosen] = useState<ChosenState | null>(initialChosen);
  const [changing, setChanging] = useState(false);
  const failure = (text: string) => {
    const kept = t("decisions.change.kept");
    return { ok: false, text: chosen && !text.includes(kept) ? t("decisions.change.failed", { kept, error: text }) : text };
  };
  const done = (choice: string, result: { ok: boolean; message: string }, answerId: string) => {
    const next = chosenFor(choice, result, answerId);
    if (next) setChosen(next);
    setChanging(false);
    setMsg(next ? null : result.ok ? { ok: true, text: result.message } : failure(result.message));
    onResult?.({
      ok: result.ok,
      text: result.message,
      chosen: next ?? undefined,
      panelClosed: result.ok && choice === REPLY_CHOICE.dismiss ? true : undefined,
      panelRestored: result.ok && choice === REPLY_CHOICE.restore ? true : undefined,
    });
    if (result.ok) void client.invalidateQueries({ queryKey: ["afc", "snapshot"] });
  };
  const send = (choice: string, body: string): Promise<{ ok: boolean; message: string }> => {
    setBusy(true);
    setMsg(null);
    const call = chosen && changing
      ? change({ id: currentId, choice, text: body }).then((result) => ({ result, answerId: result.ok && result.newId ? result.newId : currentId }))
      : reply({ id, choice, text: body }).then((result) => ({ result, answerId: id }));
    return call
      .then(({ result, answerId }) => {
        if (answerId !== currentId) setCurrentId(answerId);
        done(choice, result, answerId);
        return result;
      })
      .catch((error: unknown) => {
        const next = failure(replyError(error).text);
        setChanging(false);
        setMsg(next);
        onResult?.(next);
        return { ok: false, message: next.text };
      })
      .finally(() => setBusy(false));
  };
  /** The recorded choice stays until a new one is accepted; a refused change falls back to it. */
  const startChange = () => { setChanging(true); setMsg(null); };
  const cancelChange = () => { setChanging(false); setMsg(null); };
  return { text, setText, busy, msg, send, chosen, changing, startChange, cancelChange };
}

function chosenFor(choice: string, result: { ok: boolean; message: string }, id: string): ChosenState | null {
  if (!result.ok || !/^[A-D]$/.test(choice)) return null;
  return { id, letter: choice, message: result.message, at: Date.now() };
}

type Reply = ReturnType<typeof useDecisionReply>;

function OptionList({ s, card, busy, confirming, onAsk, onPick }: {
  s: Styles;
  card: ReturnType<typeof parseDecisionCard>;
  busy: boolean;
  confirming: string | null;
  onAsk: (letter: string | null) => void;
  onPick: (letter: string) => void;
}) {
  return (
    <View style={{ gap: 10 }}>
      {card.options.map((option) => {
        const recommended = option.letter === card.recommended;
        return (
          <View key={option.letter} style={{ gap: 6 }}>
            <OptionButton s={s} option={option} recommended={recommended} active={confirming === option.letter} busy={busy} onPress={() => onAsk(confirming === option.letter ? null : option.letter)} />
            {recommended && card.reason ? <Text style={[s.muted, { paddingHorizontal: 4 }]}>{t("decisions.actions.reason", { reason: card.reason })}</Text> : null}
            {confirming === option.letter ? <ConfirmPick s={s} option={option} busy={busy} onYes={() => onPick(option.letter)} onNo={() => onAsk(null)} /> : null}
          </View>
        );
      })}
    </View>
  );
}

function OptionButton({ s, option, recommended, active, busy, onPress }: {
  s: Styles; option: CardOption; recommended: boolean; active: boolean; busy: boolean; onPress: () => void;
}) {
  const highlight = recommended || active;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${option.text ? t("decisions.actions.pickWithText", { letter: option.letter, text: option.text }) : t("decisions.actions.pick", { letter: option.letter })}${recommended ? t("decisions.actions.recommendedSuffix") : ""}`}
      disabled={busy}
      style={pressed({
        width: "100%",
        minHeight: BUTTON_MIN_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: highlight ? 2 : 1,
        borderColor: highlight ? s.p.blue : s.p.border,
        backgroundColor: recommended ? s.p.blueBg : s.p.raised,
      })}
      onPress={onPress}
    >
      <View style={{ width: LETTER_BOX, height: LETTER_BOX, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: recommended ? s.p.primaryBg : s.p.card, borderWidth: recommended ? 0 : 1, borderColor: s.p.border }}>
        <Text style={[s.h2, { color: recommended ? s.p.primaryFg : s.p.text }]}>{option.letter}</Text>
      </View>
      <Text style={[s.text, { flex: 1, minWidth: 0 }]}>{option.text || t("decisions.actions.noText")}</Text>
      {recommended ? <RecommendTag s={s} /> : null}
    </Pressable>
  );
}

function RecommendTag({ s }: { s: Styles }) {
  return (
    <View style={{ backgroundColor: s.p.accentBg, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2, alignSelf: "flex-start", flexShrink: 0 }}>
      <Text style={[s.badgeText, { color: s.p.accent }]}>{t("decisions.actions.recommended")}</Text>
    </View>
  );
}

function ConfirmPick({ s, option, busy, onYes, onNo }: { s: Styles; option: CardOption; busy: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <View style={{ gap: 8, paddingHorizontal: 4 }}>
      <Text style={[s.text, { fontWeight: "600" }]}>{confirmLine(option.letter, option.text)}</Text>
      <View style={s.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.confirmPick", { letter: option.letter })} disabled={busy} style={pressed([s.button, { minHeight: 48, minWidth: 96, alignItems: "center" }])} onPress={onYes}>
          <Text style={s.buttonText}>{busy ? t("decisions.actions.saving") : t("decisions.actions.confirm")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.cancelPick")} disabled={busy} style={pressed([s.ghost, { minHeight: 48, minWidth: 80, alignItems: "center" }])} onPress={onNo}>
          <Text style={s.ghostText}>{t("decisions.actions.cancel")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ChosenBox({ s, chosen, busy, msg, canChange, onChange }: {
  s: Styles; chosen: ChosenState; busy: boolean; msg: { ok: boolean; text: string } | null; canChange: boolean; onChange: () => void;
}) {
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: 10, backgroundColor: s.p.greenBg, borderWidth: 1, borderColor: s.p.green }}>
      <Text style={[s.text, { color: s.p.green, fontWeight: "600" }]}>{`✓ ${chosenLine(chosen)}`}</Text>
      {msg ? <Text style={msg.ok ? s.green : s.red}>{msg.text}</Text> : null}
      {canChange ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.change")} disabled={busy} style={pressed([s.ghost, { alignSelf: "flex-start" }])} onPress={onChange}>
          <Text style={s.ghostText}>{t("decisions.actions.change")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ChangingNote({ s, onBack }: { s: Styles; onBack: () => void }) {
  return (
    <View style={s.row}>
      <Text style={[s.muted, { flexShrink: 1 }]}>{t("decisions.actions.changingNote")}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.keep")} style={pressed(s.ghost)} onPress={onBack}>
        <Text style={s.ghostText}>{t("decisions.actions.keep")}</Text>
      </Pressable>
    </View>
  );
}

function MissingOptions({ s, allowText, busy, onAsk }: { s: Styles; allowText: boolean; busy: boolean; onAsk: () => void }) {
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: 10, backgroundColor: s.p.amberBg }}>
      <Text style={[s.text, { fontWeight: "600" }]}>{t("decisions.actions.noOptions")}</Text>
      {allowText ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.askOptions")} disabled={busy} style={pressed([s.button, { minHeight: 48, width: "100%", alignItems: "center" }])} onPress={onAsk}>
          <Text style={s.buttonText}>{t("decisions.actions.askOptions")}</Text>
        </Pressable>
      ) : <Text style={s.muted}>{noLeaderHint()}</Text>}
    </View>
  );
}

function CommentBox({ s, reply, hasOptions }: { s: Styles; reply: Reply; hasOptions: boolean }) {
  const empty = reply.text.trim().length === 0;
  return (
    <View style={{ gap: 8 }}>
      <TextInput selectionColor={s.p.blue} cursorColor={s.p.text} accessibilityLabel={t("decisions.actions.addNote")} style={[s.ghost, s.text, { width: "100%" }]} value={reply.text} onChangeText={reply.setText} placeholder={t("decisions.actions.addNote")} placeholderTextColor={s.p.hint} editable={!reply.busy} />
      <Text style={s.muted}>{hasOptions ? t("decisions.actions.noteHintWithOptions") : t("decisions.actions.noteHint")}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.sendNote")} disabled={reply.busy || empty} style={pressed([s.button, { alignSelf: "flex-start", opacity: empty ? 0.5 : 1 }])} onPress={() => reply.send(REPLY_CHOICE.comment, reply.text)}>
        <Text style={s.buttonText}>{t("decisions.actions.send")}</Text>
      </Pressable>
    </View>
  );
}

function DismissConfirm({ s, busy, onYes, onNo }: { s: Styles; busy: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.text}>{t("decisions.actions.dismissConfirm")}</Text>
      <View style={s.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.dismissYesLabel")} disabled={busy} style={pressed([s.button, { minHeight: 44 }])} onPress={onYes}>
          <Text style={s.buttonText}>{t("decisions.actions.dismissYes")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.cancel")} disabled={busy} style={pressed([s.ghost, { minHeight: 44 }])} onPress={onNo}>
          <Text style={s.ghostText}>{t("decisions.actions.cancel")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ClosedBox({ s, busy, msg, onUndo }: { s: Styles; busy: boolean; msg: { ok: boolean; text: string } | null; onUndo: () => void }) {
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: 10, backgroundColor: s.p.greenBg, borderWidth: 1, borderColor: s.p.green }}>
      <Text style={[s.text, { color: s.p.green, fontWeight: "600" }]}>{t("decisions.actions.dismissed")}</Text>
      {msg ? <Text style={msg.ok ? s.green : s.red}>{msg.text}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.dismissUndoLabel")} disabled={busy} style={pressed([s.ghost, { alignSelf: "flex-start", minHeight: 44 }])} onPress={onUndo}>
        <Text style={s.ghostText}>{t("decisions.actions.dismissUndo")}</Text>
      </Pressable>
    </View>
  );
}

function ShelveConfirm({ s, busy, onYes, onNo }: { s: Styles; busy: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.text}>{t("decisions.actions.shelveConfirm")}</Text>
      <View style={s.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.shelveYesLabel")} disabled={busy} style={pressed(s.button)} onPress={onYes}>
          <Text style={s.buttonText}>{t("decisions.actions.shelveYes")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.shelveNo")} disabled={busy} style={pressed(s.ghost)} onPress={onNo}>
          <Text style={s.ghostText}>{t("decisions.actions.cancel")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SecondaryRow({ s, busy, canWrite, writing, onWrite, onDefer, onShelve, onDismiss }: {
  s: Styles;
  busy: boolean;
  canWrite: boolean;
  writing: boolean;
  onWrite: () => void;
  onDefer?: () => void;
  onShelve?: () => void;
  onDismiss?: () => void;
}) {
  if (!canWrite && !onDefer && !onShelve && !onDismiss) return null;
  return (
    <View style={[s.row, { gap: 4, flexWrap: "wrap", borderTopWidth: 1, borderTopColor: s.p.border, paddingTop: 4 }]}>
      {canWrite ? <LinkButton s={s} label={writing ? t("decisions.actions.hideNote") : t("decisions.actions.addNote")} busy={busy} onPress={onWrite} /> : null}
      {onDefer ? <LinkButton s={s} label={t("decisions.meta.deferred")} busy={busy} onPress={onDefer} /> : null}
      {onShelve ? <LinkButton s={s} label={t("decisions.actions.shelve")} busy={busy} onPress={onShelve} danger /> : null}
      {onDismiss ? <LinkButton s={s} label={t("decisions.actions.dismiss")} busy={busy} onPress={onDismiss} /> : null}
    </View>
  );
}

function LinkButton({ s, label, busy, onPress, danger = false }: { s: Styles; label: string; busy: boolean; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy} style={pressed({ minHeight: 44, paddingHorizontal: 10, justifyContent: "center" })} onPress={onPress}>
      <Text style={[s.ghostText, { color: danger ? s.p.red : s.p.textSecondary, textDecorationLine: "underline" }]}>{label}</Text>
    </Pressable>
  );
}

export function OpenSession({ s, agentId, openAgent, title }: {
  s: Styles; agentId: string | null; openAgent: OpenAgent; title: string;
}) {
  if (!agentId || !openAgent) return <Text style={s.red}>{t("decisions.actions.sessionMissing")}</Text>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={t("decisions.actions.openSessionLabel", { title })} style={pressed([s.button, { alignSelf: "flex-start" }])} onPress={() => openAgent(agentId)}>
      <Text style={s.buttonText}>{t("decisions.actions.openSession")}</Text>
    </Pressable>
  );
}
