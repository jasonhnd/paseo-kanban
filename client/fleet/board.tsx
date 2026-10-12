import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { accessRpc } from "../../shared/fleet/access";
import { agentLinkRpc, boardInsightsRpc, boardSnapshotRpc, openAgentRpc } from "../../shared/fleet/board";
import {
  appearanceDirty,
  boardWarnings,
  FONT_OPTIONS,
  INSIGHTS_MS,
  openChannel,
  phoneLinkPlan,
  phoneOpenError,
  prefsSaveFailed,
  desktopOpenNotice,
  shouldWarmUsage,
  snapshotRefetchMs,
  SNAPSHOT_TABS,
  splitPrefsPatch,
  TAB_HINT,
  USAGE_WARM_MS,
} from "../../shared/fleet/board-chrome";
import { INITIAL_PREFS_VIEW, prefsReducer, resolvePrefs, type PrefsAction } from "../../shared/fleet/panel-prefs-state";
import { language, setLanguage, t } from "../../shared/fleet/i18n";
import { type PanelPrefs, panelPrefsRpc, parsePanelPrefs } from "../../shared/fleet/panel-prefs";
import { panelTabBadges, type PanelTab } from "../../shared/fleet/panel-tabs";
import { boardUsageRpc } from "../../shared/fleet/usage";
import { Access } from "./access";
import { Home, LeaderTab, UsageTab } from "./home";
import { QuotaBlock } from "./home-quota";
import { PanelTabs } from "./panel-tabs";
import { Quota } from "./quota";
import { Records } from "./records";
import { RolesTab } from "./roles";
import { TabPane, useMountedTabs } from "./tab-pane";
import { Empty, Fold, type OpenAgent, pressed, Segmented, timeAgo, useStyles } from "./ui";

type BoardProps = Pick<PluginSurfaceProps, "theme" | "layout" | "navigation">;

const SNAPSHOT_KEY = ["afc", "snapshot"] as const;

export function RoleBoard({ theme, layout, navigation, tab, onTabChange, integrated = false }: PluginSurfaceProps & { tab?: PanelTab; onTabChange?: (tab: PanelTab) => void; integrated?: boolean }) {
  const board = useRoleBoard({ theme, layout, navigation }, tab, onTabChange, integrated);
  // Keyed on the language so every row renders again in the server's language once the prefs reply arrives.
  return (
    <View key={board.lang} style={board.s.screen} onLayout={(event) => board.setPanelWidth(event.nativeEvent.layout.width)}>
      <ScrollView ref={board.contentScroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets style={board.s.screen} contentContainerStyle={board.s.content}>
        <BoardHeader s={board.s} prefs={board.prefs} generatedAt={board.snap?.generatedAt} onSave={board.savePrefs} onRefresh={() => { board.refreshSnapshot(); board.insights.refetch(); }} />
        {!integrated ? <PanelTabs s={board.s} tab={board.tab} badges={board.badges} onChange={(next) => { board.selectTab(next); board.contentScroll.current?.scrollTo({ y: 0, animated: false }); }} /> : null}
        {TAB_HINT[board.tab] ? <Text style={board.s.muted}>{TAB_HINT[board.tab]}</Text> : null}
        {board.notice ? <Text style={board.s.yellow}>{board.notice}</Text> : null}
        {board.snapshot.isError ? <Text style={board.s.red}>{t("board.readFailed", { error: String(board.snapshot.error) })}</Text> : null}
        <WarningFold s={board.s} warnings={board.warnings} />
        <BoardBody s={board.s} tab={board.tab} snap={board.snap} mounted={board.mounted} insights={board.insights.data} openAgent={board.openAgent} selectTab={board.selectTab} />
      </ScrollView>
    </View>
  );
}

function useRoleBoard({ theme, layout, navigation }: BoardProps, controlledTab?: PanelTab, onTabChange?: (tab: PanelTab) => void, integrated = false) {
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const { width } = useWindowDimensions();
  const chrome = usePanelChrome(theme, layout, panelWidth, width, integrated);
  const data = useBoardQueries(chrome.queryClient);
  const openAgent = useOpenAgent(layout.platform, navigation, chrome.setNotice);
  const tab = controlledTab ?? chrome.prefs.tab;
  const mounted = useMountedTabs(tab, SNAPSHOT_TABS, Boolean(data.snap));
  const badges = panelTabBadges(data.snap, data.insights.data, data.access.data?.services.length ?? 0);
  const warnings = boardWarnings(data.snap?.warnings, data.insights.data?.warnings);
  const selectTab = (next: PanelTab) => { onTabChange?.(next); chrome.savePrefs({ tab: next }); };
  return { ...chrome, ...data, openAgent, tab, mounted, badges, warnings, setPanelWidth, selectTab };
}

function usePanelChrome(theme: PluginSurfaceProps["theme"], layout: PluginSurfaceProps["layout"], panelWidth: number | null, windowWidth: number, integrated = false) {
  const prefsRpc = useRpc(panelPrefsRpc);
  const queryClient = useQueryClient();
  const loaded = useQuery({ queryKey: ["afc", "prefs"], queryFn: () => prefsRpc({}) });
  const lang = integrated ? language() : followServerLanguage(loaded.data?.language);
  const [view, dispatch] = useReducer(prefsReducer, INITIAL_PREFS_VIEW);
  const prefsRev = useRef(0);
  const prefsQueue = useRef<Promise<void>>(Promise.resolve());
  const prefs = resolvePrefs(view, loaded.data);
  const s = useStyles(theme, layout, prefs, panelWidth ?? windowWidth);
  const [notice, setNotice] = useState<string | null>(null);
  const contentScroll = useRef<ScrollView>(null);
  const savePrefs = (patch: Partial<PanelPrefs>) => {
    const id = ++prefsRev.current;
    dispatchPrefs(patch, prefs, dispatch);
    // Save after the click has painted so the RPC never competes with the tab switch.
    prefsQueue.current = prefsQueue.current
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      .then(() => prefsRpc(patch))
      .then((saved) => {
        queryClient.setQueryData(["afc", "prefs"], parsePanelPrefs(saved));
        if (prefsRev.current === id) dispatch({ type: "saved", saved });
      })
      .catch(() => {
        if (prefsRev.current === id) dispatch({ type: "save-failed", loaded: queryClient.getQueryData<PanelPrefs>(["afc", "prefs"]) });
        setNotice(prefsSaveFailed());
      });
  };
  return { prefs, s, savePrefs, notice, setNotice, queryClient, contentScroll, lang };
}

/** Follow the server's language. Set during render, before any child calls t(). */
function followServerLanguage(serverLanguage: ReturnType<typeof language> | undefined) {
  if (serverLanguage && serverLanguage !== language()) setLanguage(serverLanguage);
  return language();
}

function dispatchPrefs(patch: Partial<PanelPrefs>, prefs: PanelPrefs, dispatch: (action: PrefsAction) => void) {
  const split = splitPrefsPatch(patch);
  if (split.tab) dispatch({ type: "select-tab", tab: split.tab });
  if (appearanceDirty(split.appearance)) dispatch({ type: "set-appearance", patch: split.appearance, base: prefs });
}

function useBoardQueries(queryClient: QueryClient) {
  const snapshotRpc = useRpc(boardSnapshotRpc);
  const insightsRpc = useRpc(boardInsightsRpc);
  const usageRpc = useRpc(boardUsageRpc);
  const accessRead = useRpc(accessRpc);
  const snapshot = useQuery({
    queryKey: SNAPSHOT_KEY,
    queryFn: () => snapshotRpc({}),
    refetchInterval: (query) => snapshotRefetchMs(query.state.data?.generatedAt, Date.now()),
  });
  // The refresh button waits for a new round instead of the server's cached one. A failure shows as the query's error.
  const refreshSnapshot = () => {
    queryClient.fetchQuery({ queryKey: SNAPSHOT_KEY, queryFn: () => snapshotRpc({ force: true }), staleTime: 0 }).catch(() => undefined);
  };
  const insights = useQuery({ queryKey: ["afc", "insights"], queryFn: () => insightsRpc({}), refetchInterval: INSIGHTS_MS });
  const access = useQuery({ queryKey: ["afc", "access"], queryFn: () => accessRead({ refresh: false }), refetchInterval: INSIGHTS_MS });
  useWarmUsage(Boolean(snapshot.data), queryClient, usageRpc);
  return { snapshot, insights, access, snap: snapshot.data, refreshSnapshot };
}

function useWarmUsage(ready: boolean, queryClient: QueryClient, usageRpc: (input: { period: "7d" }) => Promise<unknown>) {
  const warmed = useRef(false);
  useEffect(() => {
    if (!shouldWarmUsage(ready, warmed.current)) return;
    const timer = setTimeout(() => {
      warmed.current = true;
      void queryClient.prefetchQuery({ queryKey: ["afc", "usage", "7d"], queryFn: () => usageRpc({ period: "7d" }) });
    }, USAGE_WARM_MS);
    return () => clearTimeout(timer);
  }, [ready, queryClient, usageRpc]);
}

function useOpenAgent(platform: string, navigation: PluginSurfaceProps["navigation"], setNotice: (notice: string | null) => void): OpenAgent {
  const openOnDesktop = useRpc(openAgentRpc);
  const agentLink = useRpc(agentLinkRpc);
  return (agentId) => {
    if (openChannel(platform) === "desktop") {
      openOnDesktop({ agentId }).then((result) => setNotice(desktopOpenNotice(result.ok, result.message))).catch(() => navigation?.openAgent({ agentId }));
      return;
    }
    agentLink({ agentId })
      .then(async (result) => {
        const plan = phoneLinkPlan(result.url, result.message);
        setNotice(plan.notice);
        if (plan.url) await Linking.openURL(plan.url);
      })
      .catch((error: unknown) => {
        setNotice(phoneOpenError(error));
        navigation?.openAgent({ agentId });
      });
  };
}

function BoardHeader({ s, prefs, generatedAt, onSave, onRefresh }: {
  s: ReturnType<typeof useStyles>;
  prefs: PanelPrefs;
  generatedAt: string | undefined;
  onSave: (patch: Partial<PanelPrefs>) => void;
  onRefresh: () => void;
}) {
  return (
    <View style={s.compact ? { gap: 8 } : { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
      <Text style={[s.title, s.compact ? { maxWidth: "100%" } : { flexGrow: 1, flexShrink: 1 }]}>Paseo Kanban</Text>
      <BoardTools s={s} prefs={prefs} generatedAt={generatedAt} onSave={onSave} onRefresh={onRefresh} />
    </View>
  );
}

function BoardTools({ s, prefs, generatedAt, onSave, onRefresh }: {
  s: ReturnType<typeof useStyles>; prefs: PanelPrefs; generatedAt: string | undefined; onSave: (patch: Partial<PanelPrefs>) => void; onRefresh: () => void;
}) {
  return (
    <View style={{ gap: 8, maxWidth: "100%", flexShrink: 0, alignItems: s.compact ? "flex-start" : "flex-end" }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, maxWidth: "100%" }}>
        <Segmented s={s} label={t("board.fontSize")} value={prefs.fontStep} options={FONT_OPTIONS} onChange={(fontStep) => onSave({ fontStep })} />
      </View>
      <RefreshRow s={s} generatedAt={generatedAt} onRefresh={onRefresh} />
    </View>
  );
}

function RefreshRow({ s, generatedAt, onRefresh }: { s: ReturnType<typeof useStyles>; generatedAt: string | undefined; onRefresh: () => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, maxWidth: "100%" }}>
      <Text style={[s.muted, { fontVariant: ["tabular-nums"], flexShrink: 0 }]}>{generatedAt ? t("board.updatedAgo", { ago: timeAgo(generatedAt) }) : t("board.loading")}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t("board.refreshNow")} style={pressed(s.button)} onPress={onRefresh}>
        <Text style={s.buttonText}>{t("board.refresh")}</Text>
      </Pressable>
    </View>
  );
}

function WarningFold({ s, warnings }: { s: ReturnType<typeof useStyles>; warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <Fold s={s} title={t("board.warnings.title")} summary={t("board.warnings.count", { count: warnings.length })}>
      {warnings.map((warning) => <Text key={warning} style={s.muted}>ⓘ {warning}</Text>)}
    </Fold>
  );
}

function BoardBody({ s, tab, snap, mounted, insights, openAgent, selectTab }: {
  s: ReturnType<typeof useStyles>;
  tab: PanelTab;
  snap: ReturnType<typeof useBoardQueries>["snap"];
  mounted: ReadonlySet<PanelTab>;
  insights: ReturnType<typeof useBoardQueries>["insights"]["data"];
  openAgent: OpenAgent;
  selectTab: (tab: PanelTab) => void;
}) {
  return (
    <>
      {tab === "quota" ? <QuotaPane s={s} snap={snap} /> : null}
      {tab === "access" ? <Access s={s} /> : null}
      {!snap && tab !== "quota" && tab !== "access" ? <Empty s={s} text={t("board.loading")} /> : null}
      {snap ? <SnapshotPanes s={s} tab={tab} snap={snap} mounted={mounted} insights={insights} openAgent={openAgent} selectTab={selectTab} /> : null}
    </>
  );
}

function QuotaPane({ s, snap }: { s: ReturnType<typeof useStyles>; snap: ReturnType<typeof useBoardQueries>["snap"] }) {
  return (
    <View style={{ gap: 24 }}>
      {snap ? <QuotaBlock s={s} companies={snap.home.companies} /> : <Empty s={s} text={t("board.loadingQuota")} />}
      <Quota s={s} antigravityInSummary={!!snap} />
    </View>
  );
}

function SnapshotPanes({ s, tab, snap, mounted, insights, openAgent, selectTab }: {
  s: ReturnType<typeof useStyles>;
  tab: PanelTab;
  snap: NonNullable<ReturnType<typeof useBoardQueries>["snap"]>;
  mounted: ReadonlySet<PanelTab>;
  insights: ReturnType<typeof useBoardQueries>["insights"]["data"];
  openAgent: OpenAgent;
  selectTab: (tab: PanelTab) => void;
}) {
  return (
    <>
      {mounted.has("overview") ? <TabPane active={tab === "overview"}><Home s={s} data={snap} onNavigate={selectTab} /></TabPane> : null}
      {mounted.has("leader") ? <TabPane active={tab === "leader"}><LeaderTab s={s} data={snap} openAgent={openAgent} /></TabPane> : null}
      {mounted.has("usage") ? <TabPane active={tab === "usage"}><UsageTab s={s} data={snap} onNavigate={selectTab} /></TabPane> : null}
      {mounted.has("roles") ? <TabPane active={tab === "roles"}><RolesTab s={s} models={insights?.models} /></TabPane> : null}
      {mounted.has("records") ? <TabPane active={tab === "records"}><Records s={s} data={snap} insights={insights} openAgent={openAgent} onNavigate={selectTab} /></TabPane> : null}
    </>
  );
}
