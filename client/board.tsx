import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { RpcUpdateNotice, useRpc } from "./rpc";
import { useQueryClient } from "@tanstack/react-query";
import { useQuery } from "./query";
import { useEffect, useRef, useState } from "react";
import { Linking, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { attentionGroups, boardTabBadges, quietAttention, systemAlerts } from "../shared/board-view";
import { t } from "../shared/i18n";
import { LEADER_LABEL } from "../shared/labels";
import { BOARD_TABS, boardTabRpc, DEFAULT_BOARD_TAB, DEFAULT_PANEL_PREFS, type BoardTab, type PanelPrefs, panelPrefsRpc } from "../shared/panel-prefs";
import { agentLinkRpc, agentsRpc, archiveRpc, autoStartRpc, boardRpc, decisionsRpc, fallbackSupervisorRpc, intakeRpc, openAgentRpc, resolveCardRpc, setTierRpc, startRpc, supervisorRpc, unblockRpc } from "../shared/rpc";
import { AttentionView, OverviewColumns, ProjectsView } from "./board-views";
import { BoardTabs } from "./board-tabs";
import { CardDrawer, type DrawerActions } from "./card-drawer";
import { DecisionsPanel } from "./decisions";
import { BOARD_REFRESH_MS, DECISIONS_REFRESH_MS, formatClock, useRefreshOnVisible } from "./refresh";
import { HistoryPanel } from "./history";
import { useI18n } from "./i18n";
import { PanelPrefsControls } from "./prefs-controls";
import { LeaderStartPanel } from "./leader-start";
import { SettingsPanel } from "./settings-panel";
import { Banner, Button, Chip, Empty, useStyles } from "./ui";

function attentionMemo(): string {
  return t("board.attention.memo", { leader: LEADER_LABEL });
}

/** Placeholder for the first read: the tab bar without counts and a few grey rows, never the board itself. */
function BoardSkeleton({ s, tabs }: { s: ReturnType<typeof useStyles>; tabs: readonly BoardTab[] }) {
  return (
    <View testID="board-skeleton" style={{ gap: 12 }}>
      <BoardTabs s={s} tab={null} tabs={tabs} badges={null} onChange={() => undefined} />
      <Text style={s.muted}>{t("board.loading")}</Text>
      {[0, 1, 2].map((row) => (
        <View key={row} style={[s.compactCard, { opacity: 0.4, minHeight: 56 }]} />
      ))}
    </View>
  );
}

export interface RefreshIntervals {
  boardMs: number;
  decisionsMs: number;
}

export function KanbanBoard({ theme, layout, navigation, lockedProject, refresh: intervals = { boardMs: BOARD_REFRESH_MS, decisionsMs: DECISIONS_REFRESH_MS } }: PluginSurfaceProps & { lockedProject?: string | null; refresh?: RefreshIntervals }) {
  // Reads the language setting once and re-renders the whole board when it differs from the guess.
  useI18n();
  const viewport = useWindowDimensions();
  // Stack the three columns on a phone-width screen instead of sliding sideways.
  // Above 480px the columns stay side by side and share the board width.
  const narrow = viewport.width <= 480;
  const queryClient = useQueryClient();
  const prefsRpc = useRpc(panelPrefsRpc);
  const tabRpc = useRpc(boardTabRpc);
  const loadedPrefs = useQuery({
    queryKey: ["kanban", "prefs"],
    queryFn: () => prefsRpc({}),
    refetchInterval: 5000,
    refetchOnMount: "always",
  });
  const savedTab = useQuery({ queryKey: ["kanban", "board-tab"], queryFn: () => tabRpc({}), retry: false, refetchOnMount: "always" });
  const [override, setOverride] = useState<PanelPrefs | null>(null);
  const [tabOverride, setTabOverride] = useState<BoardTab | null>(null);
  const loaded = loadedPrefs.data;
  const prefs: PanelPrefs = override ?? (loaded ? { fontStep: loaded.fontStep } : DEFAULT_PANEL_PREFS);
  const s = useStyles(theme, layout, prefs, narrow);
  const loadBoard = useRpc(boardRpc);
  const archive = useRpc(archiveRpc);
  const unblock = useRpc(unblockRpc);
  const start = useRpc(startRpc);
  const setTier = useRpc(setTierRpc);
  const openOnDesktop = useRpc(openAgentRpc);
  const linkForPhone = useRpc(agentLinkRpc);
  const dropRequest = useRpc(intakeRpc);
  const setAuto = useRpc(autoStartRpc);
  const loadAgents = useRpc(agentsRpc);
  const setSupervisor = useRpc(supervisorRpc);
  const setFallback = useRpc(fallbackSupervisorRpc);
  const locked = lockedProject !== undefined;
  const [project, setProject] = useState<string>(lockedProject ?? "");
  useEffect(() => {
    if (lockedProject) setProject(lockedProject);
  }, [lockedProject]);
  const [selected, setSelected] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [demand, setDemand] = useState("");
  const [demandProject, setDemandProject] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");

  const visibleTabs: readonly BoardTab[] = locked ? BOARD_TABS.filter((id) => id !== "projects") : BOARD_TABS;
  const wanted = tabOverride ?? savedTab.data?.tab ?? DEFAULT_BOARD_TAB;
  const tab: BoardTab = visibleTabs.includes(wanted) ? wanted : DEFAULT_BOARD_TAB;

  // Every read is fresh: no stale window, re-read on every mount, and keep ticking while the panel is hidden
  // so a reopened panel never waits for the next interval. Old data stays on screen while the new read runs.
  const board = useQuery({
    queryKey: ["kanban", "board", project],
    queryFn: () => loadBoard(project ? { project } : {}),
    enabled: !locked || Boolean(project),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchIntervalInBackground: true,
    refetchInterval: intervals.boardMs,
  });
  const loadDecisions = useRpc(decisionsRpc);
  const resolveCardCall = useRpc(resolveCardRpc);
  const decisionsQuery = useQuery({
    queryKey: ["kanban", "decisions", project],
    queryFn: () => loadDecisions(project ? { project } : {}),
    enabled: tab === "decisions" && (!locked || Boolean(project)),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchIntervalInBackground: true,
    refetchInterval: intervals.decisionsMs,
  });
  const agents = useQuery({
    queryKey: ["kanban", "agents", project],
    queryFn: () => loadAgents({ project }),
    enabled: tab === "settings" && Boolean(project),
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["kanban"] });
  }

  function chooseTab(next: BoardTab) {
    setTabOverride(next);
    queryClient.setQueryData(["kanban", "board-tab"], { tab: next });
    void tabRpc({ tab: next }).catch((error: unknown) => setNotice(String(error)));
  }

  useRefreshOnVisible(refresh);
  // Switching tabs re-reads the board too, so a tab opened after a while never shows the old picture.
  const firstTab = useRef(true);
  useEffect(() => {
    if (firstTab.current) {
      firstTab.current = false;
      return;
    }
    if (tab === "overview" || tab === "attention") void board.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  function openAgent(agentId: string) {
    if (layout.platform === "web") {
      openOnDesktop({ agentId })
        .then((r) => setNotice(r.ok ? null : r.message))
        .catch(() => navigation?.openAgent({ agentId }));
      return;
    }
    linkForPhone({ agentId })
      .then(async (r) => {
        if (!r.url) {
          setNotice(r.message);
          return;
        }
        setNotice(null);
        await Linking.openURL(r.url);
      })
      .catch((err) => {
        setNotice(t("board.openFailed", { error: String(err) }));
        navigation?.openAgent({ agentId });
      });
  }

  async function runAction(work: () => Promise<{ ok: boolean; message: string }>) {
    try {
      const result = await work();
      setNotice(result.message);
      refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  const actions: DrawerActions = {
    start: (id) => void runAction(() => start({ id })),
    unblock: (id) => void runAction(() => unblock({ id })),
    archive: (id) => void runAction(() => archive({ id })),
    setTier: (id, tier) => void runAction(() => setTier({ id, tier })),
  };

  const stackHeader = narrow || layout.compact;
  const data = board.data;
  // The decisions list comes from whichever read is newer: the board's, or the decisions tab's own.
  const ownDecisions = decisionsQuery.data && decisionsQuery.dataUpdatedAt >= board.dataUpdatedAt ? decisionsQuery.data.decisions : undefined;
  const decisionSnapshot = ownDecisions ?? data?.decisions;
  const shownAt = tab === "decisions" && decisionsQuery.dataUpdatedAt > 0 ? decisionsQuery.dataUpdatedAt : board.dataUpdatedAt;
  const refreshing = board.isFetching || (tab === "decisions" && decisionsQuery.isFetching);
  const updated = `${shownAt > 0 ? t("board.updatedAt", { time: formatClock(shownAt) }) : t("board.loading")}${refreshing && shownAt > 0 ? ` · ${t("board.refreshing")}` : ""}`;
  const tasks = data?.tasks ?? [];
  const decisions = decisionSnapshot?.items ?? [];
  const projects = [...new Set([...(data?.projects ?? []), ...decisions.map((item) => item.project)])];
  const alerts = data ? systemAlerts(data) : [];
  const groups = attentionGroups(tasks, decisions);
  const quiet = quietAttention(tasks, decisions);
  const reds = data?.doctorReds ?? [];
  const badges = boardTabBadges({ tasks, decisions, projects: data?.projectRows?.length ?? projects.length, alerts, doctorReds: reds.length });
  const empty = Boolean(data) && tasks.length === 0;
  // First paint is a skeleton until the saved tab, the prefs and the first board read are in, so the default
  // overview columns never flash before the tab the user actually left on.
  const settled = (savedTab.isSuccess || savedTab.isError) && (loadedPrefs.isSuccess || loadedPrefs.isError);
  const ready = settled && (Boolean(data) || board.isError) && !(locked && !project);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView testID="kanban-screen" style={s.screen} contentContainerStyle={s.content}>
        <View style={stackHeader ? { gap: 12, maxWidth: "100%" } : { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 12, maxWidth: "100%" }}>
          <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: "100%", gap: 4 }}>
            <Text style={s.title}>Paseo Kanban</Text>
            <Text style={s.muted}>{locked ? `${project || t("board.thisProject")}` : t("board.allProjectsBoard")}</Text>
            {data ? <Text style={s.muted}>{data.supervisorHeadline}</Text> : null}
          </View>
          <View style={{ gap: 8, maxWidth: "100%", flexShrink: 0, alignItems: stackHeader ? "flex-start" : "flex-end" }}>
            <PanelPrefsControls
              s={s}
              prefs={prefs}
              save={(next) => prefsRpc(next)}
              onOptimistic={setOverride}
              onSettled={(saved) => {
                queryClient.setQueryData(["kanban", "prefs"], { ...saved, notice: null });
                setOverride(null);
              }}
              onRevert={() => setOverride(null)}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, maxWidth: "100%" }}>
              <Text style={[s.muted, { flexShrink: 0 }]}>{updated}</Text>
              <Button s={s} label={t("board.refresh")} tone="secondary" onPress={refresh} />
            </View>
          </View>
        </View>
        {data?.supervisorPrompt ? <Banner s={s} tone="warning" text={data.supervisorPrompt} /> : null}
        {data && !data.schedulerReady ? <Banner s={s} tone="danger" text={t("boardView.alert.schedulerNotReady")} /> : null}
        {data?.schedulerIdle ? <Banner s={s} tone="danger" text={data.schedulerIdle} /> : null}
        {notice ? <Banner s={s} tone="warning" text={notice} /> : null}
        <RpcUpdateNotice style={s.muted} />
        {board.isError ? <Text style={s.bad}>{t("cardDrawer.load.failed", { error: String(board.error) })}</Text> : null}
        {ready ? <BoardTabs s={s} tab={tab} tabs={visibleTabs} badges={badges} onChange={chooseTab} /> : <BoardSkeleton s={s} tabs={visibleTabs} />}
        {locked || !ready ? null : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Chip s={s} label={t("board.allProjects")} active={project === ""} onPress={() => setProject("")} />
              {projects.map((name) => (
                <Chip key={name} s={s} label={name} active={project === name} onPress={() => setProject(name)} />
              ))}
            </View>
          </ScrollView>
        )}

        {ready && tab === "overview" ? (
          <>
            <View style={s.row}>
              <TextInput accessibilityLabel={t("board.intake.projectLabel")} placeholder={t("board.intake.projectPlaceholder")} placeholderTextColor={s.p.hint} style={s.input} value={demandProject || project} onChangeText={setDemandProject} />
              <TextInput accessibilityLabel={t("board.intake.text")} placeholder={t("board.intake.text")} placeholderTextColor={s.p.hint} style={s.input} value={demand} onChangeText={setDemand} />
              <Button
                s={s}
                label={t("board.intake.submit")}
                onPress={() => {
                  const name = (demandProject || project).trim();
                  void runAction(async () => {
                    const result = await dropRequest({ project: name, text: demand });
                    if (result.ok) {
                      setDemand("");
                      if (!project) setProject(name);
                    }
                    return result;
                  });
                }}
              />
            </View>
            {empty ? <Empty s={s} text={t("board.empty")} /> : null}
            <OverviewColumns s={s} tasks={tasks} onOpen={setSelected} showProject={project === ""} />
            <HistoryPanel
              s={s}
              project={project}
              total={data?.archivedCount ?? 0}
              open={historyOpen}
              onToggle={() => setHistoryOpen((open) => !open)}
              query={historyQuery}
              onQuery={setHistoryQuery}
              onOpenCard={setSelected}
            />
          </>
        ) : null}

        {ready && tab === "attention" ? <AttentionView s={s} groups={groups} quiet={quiet} doctorReds={reds} alerts={alerts} onOpen={setSelected} memo={groups.length > 0 ? attentionMemo() : null} /> : null}

        {ready && tab === "decisions" ? (
          <>
            <DecisionsPanel s={s} snapshot={decisionSnapshot} resolveCard={(code) => resolveCardCall({ code })} openAgent={openAgent} onOpenCard={setSelected} />
            {decisionSnapshot && !decisionSnapshot.message && decisions.length === 0 ? <Empty s={s} text={t("board.noDecisions")} /> : null}
          </>
        ) : null}

        {ready && tab === "projects" ? (
          <ProjectsView
            s={s}
            rows={data?.projectRows ?? []}
            onPick={(name) => {
              setProject(name);
              chooseTab("overview");
            }}
          />
        ) : null}

        {ready && tab === "settings" ? (
          <View style={{ gap: 12 }}>
          {project ? <LeaderStartPanel key={project} project={project} s={s} onOpen={openAgent} /> : null}
          <SettingsPanel
            s={s}
            data={{
              project,
              autoStart: data?.autoStart ?? null,
              projectSupervisorId: data?.projectSupervisorId ?? null,
              supervisorAgentId: data?.supervisorAgentId ?? null,
              poolMessage: data?.pool.message ?? "",
              concurrency: data?.concurrency ?? null,
              agents: agents.data,
            }}
            onToggleAuto={() => {
              if (!project) {
                setNotice(t("board.autoStartNeedsProject"));
                return;
              }
              void runAction(() => setAuto({ project, enabled: data?.autoStart === false }));
            }}
            onSetLeader={(agentId) => runAction(() => setSupervisor({ project, agentId }))}
            onSetFallback={(agentId) => runAction(() => setFallback({ agentId }))}
          />
          </View>
        ) : null}
      </ScrollView>
      {selected !== null ? (
        <CardDrawer
          s={s}
          id={selected}
          decisions={decisions}
          leaders={data?.leaders ?? {}}
          actions={actions}
          openAgent={openAgent}
          onOpen={setSelected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </View>
  );
}
