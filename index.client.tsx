import type { PluginClientContext, PluginSidebarItemProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Application, ApplicationSettings } from "./client/application";
import { getLanguage, languageChosen, resolveLanguage, setLanguage, t } from "./shared/i18n";
import { registerBoardPanel, rememberedLanguage, resetBoardPanel } from "./client/panel-title";

/** Screen and sidebar item share this id, so saved `/plugin/paseo-kanban/board` links keep opening the board. */
const BOARD = "board";

function projectName(root: string, display: string): string {
  const base = root.replace(/\/+$/, "").split("/").pop() || "";
  return base || display;
}

function WorkspaceBoard(props: PluginWorkspacePanelProps) {
  const name = useWorkspace(props.workspaceId, (workspace) => projectName(workspace.projectRootPath, workspace.projectDisplayName));
  return <Application {...props} lockedProject={name} />;
}

function BoardItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="SquareKanban" active={currentScreen?.screenId === BOARD} onPress={() => openScreen({ screenId: BOARD })} />;
}

export default function contribute(client: PluginClientContext) {
  // Until kanban.config.read answers (client/i18n.tsx), use the language read last time on this client,
  // else the runtime's locale. The panel is registered again if the setting turns out to differ.
  if (!languageChosen()) setLanguage(rememberedLanguage() ?? resolveLanguage("system"));
  const removeScreen = client.addScreen({ id: BOARD, title: "Paseo Kanban", Component: Application });
  // Keep the same sidebar preference key and screen id on every host and layout.
  const removeSidebar = client.addSidebarHeaderItem({
    id: BOARD,
    title: "Paseo Kanban",
    Component: BoardItem,
  });
  registerBoardPanel(client, () => ({
    id: BOARD,
    title: t("client.panel.title"),
    icon: "SquareKanban",
    context: "workspace",
    Component: WorkspaceBoard,
  }), () => ({
    id: "open-board",
    title: [t("cardDrawer.runs.open"), t("board.intake.projectPlaceholder"), t("client.panel.title")].join(getLanguage() === "zh-CN" ? "" : " "),
    icon: "SquareKanban",
    keywords: ["kanban", "board", "project"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: BOARD });
    },
  }));
  // The settings title is fixed at registration, same as the workspace panel. The form itself
  // follows the language once kanban.config.read returns; saving does not register this screen again.
  const removeSettings = client.addSettingsScreen({
    id: "config",
    title: t("settings.screen.title"),
    icon: "Settings",
    Component: ApplicationSettings,
  });
  return () => {
    resetBoardPanel();
    removeSidebar();
    removeScreen();
    removeSettings();
  };
}
