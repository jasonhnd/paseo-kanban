import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc } from "./rpc";
import { PluginUpdateError } from "./rpc-policy";
import { useQuery } from "./query";
import { t, type Language, type MessageKey } from "../shared/i18n";
import { leaderOptionsRpc, leaderPreviewRpc, leaderRecoverRpc, leaderStartRpc, leaderStatusRpc, type LeaderStartState } from "../shared/leader-start";
import { Button, Chip, type Styles } from "./ui";

const STATE_KEY: Record<LeaderStartState["state"], MessageKey> = {
  pending: "leaderStart.pending",
  ready: "leaderStart.ready",
  "protocol-missing": "leaderStart.missing",
  "delivery-failed": "leaderStart.delivery",
  registered: "leaderStart.registered",
  conflict: "leaderStart.registeredElsewhere",
};

/** Preview, create once, then read registration back. Creation is not authority to dispatch. */
export function LeaderStartPanel({ project, s, onOpen }: { project: string; s: Styles; onOpen: (agentId: string) => void }) {
  const optionsRpc = useRpc(leaderOptionsRpc);
  const previewRpc = useRpc(leaderPreviewRpc);
  const startRpc = useRpc(leaderStartRpc);
  const recoverRpc = useRpc(leaderRecoverRpc);
  const statusRpc = useRpc(leaderStatusRpc);
  const options = useQuery({ queryKey: ["kanban", "leader-options", project], queryFn: () => optionsRpc({ project }), retry: false });
  const [profileId, setProfileId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [language, setLanguage] = useState<Language>("en");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewRpc>> | null>(null);
  const [start, setStart] = useState<LeaderStartState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setStart(null);
    setProfileId("");
    setWorkspaceId("");
    setError(null);
  }, [project]);

  const data = options.data;
  const state = start ?? data?.start;
  const selection = {
    project,
    profileId: profileId || data?.profiles[0]?.id || "",
    workspaceId: workspaceId || data?.workspaces[0]?.id || "",
    language,
  };
  const invoke = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (error) {
      setError(error instanceof PluginUpdateError ? error.message : t("leaderStart.error"));
    } finally {
      setBusy(false);
    }
  };
  const choose = (update: () => void) => {
    update();
    setPreview(null);
  };

  return (
    <View testID="leader-start-panel" style={s.card}>
      <Text style={s.h2}>{t("leaderStart.title")}</Text>
      <Text style={s.muted}>{t("leaderStart.choose")}</Text>
      <View style={s.row}>
        <Text style={s.muted}>{t("leaderStart.language")}</Text>
        {(["en", "zh-CN"] as const).map((lang) => (
          <Chip key={lang} s={s} label={lang} active={language === lang} onPress={() => choose(() => setLanguage(lang))} />
        ))}
      </View>
      {data?.profiles.length === 0 ? <Text style={s.muted}>{t("leaderStart.none")}</Text> : null}
      <View style={s.row}>
        {data?.profiles.map((profile) => (
          <Chip key={profile.id} s={s} label={`${profile.name} · ${profile.provider}`} active={selection.profileId === profile.id} onPress={() => choose(() => setProfileId(profile.id))} />
        ))}
      </View>
      <View style={s.row}>
        {data?.workspaces.map((workspace) => (
          <Chip key={workspace.id} s={s} label={workspace.path} active={selection.workspaceId === workspace.id} onPress={() => choose(() => setWorkspaceId(workspace.id))} />
        ))}
      </View>
      {data ? <Text style={s.muted}>{t("leaderStart.version", { version: data.version })}</Text> : null}
      {data?.existingAgentId && data.existingAgentId !== state?.agentId ? (
        <>
          <Text style={s.muted}>{t("leaderStart.conflict")}</Text>
          <Button s={s} label={t("leaderStart.open")} onPress={() => onOpen(data.existingAgentId!)} />
        </>
      ) : null}
      {state ? (
        <>
          <Text style={s.muted}>{t(STATE_KEY[state.state])}</Text>
          {state.deliveryMode === "session-message" ? <Text style={s.muted}>{t("leaderStart.messageMode")}</Text> : null}
          {state.state === "protocol-missing" && state.agentId ? (
            <Button s={s} disabled={busy} label={t("leaderStart.recover")} onPress={() => void invoke(async () => setStart(await recoverRpc({ project })))} />
          ) : null}
          {state.agentId ? <Button s={s} label={t("leaderStart.open")} onPress={() => onOpen(state.agentId!)} /> : null}
          <Button s={s} disabled={busy} label={t("leaderStart.refresh")} onPress={() => void invoke(async () => { setStart(await statusRpc({ project })); await options.refetch(); })} />
        </>
      ) : (
        <>
          <Button
            s={s}
            label={t("leaderStart.preview")}
            disabled={busy || !selection.profileId || !selection.workspaceId || !!data?.existingAgentId}
            onPress={() => void invoke(async () => setPreview(await previewRpc(selection)))}
          />
          {preview ? (
            <>
              <Text style={s.muted}>{t("leaderStart.workspace", { path: preview.directory })}</Text>
              <Text selectable style={s.mono}>{preview.protocol}</Text>
              <View style={s.row}>
                <Button
                  s={s}
                  label={t("leaderStart.start")}
                  disabled={busy}
                  onPress={() => void invoke(async () => {
                    setStart(await startRpc({ ...selection, requestId: preview.requestId }));
                    setPreview(null);
                    await options.refetch();
                  })}
                />
                <Button s={s} tone="secondary" label={t("leaderStart.cancel")} disabled={busy} onPress={() => setPreview(null)} />
              </View>
            </>
          ) : null}
        </>
      )}
      {error || options.isError ? (
        <>
          <Text style={s.muted}>{error ?? (options.error instanceof PluginUpdateError ? options.error.message : t("leaderStart.error"))}</Text>
          <Button s={s} disabled={busy} label={t("leaderStart.refresh")} onPress={() => void invoke(async () => { setStart(await statusRpc({ project })); await options.refetch(); })} />
        </>
      ) : null}
    </View>
  );
}
