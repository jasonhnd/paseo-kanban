import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { Application, ApplicationSettings } from "./client/application";
import { languageChosen, resolveLanguage, setLanguage, t } from "./shared/i18n";
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

export default function contribute(client: PluginClientContext) {
  // Until kanban.config.read answers (client/i18n.tsx), use the language read last time on this client,
  // else the runtime's locale. The panel is registered again if the setting turns out to differ.
  if (!languageChosen()) setLanguage(rememberedLanguage() ?? resolveLanguage("system"));
  const removeScreen = client.addScreen({ id: BOARD, title: "Paseo Kanban", Component: Application });
  // One standard item. The installed host paints it in both the desktop and compact sidebars.
  // A custom header component is omitted when that host has no runtime client.
  const removeSidebar = client.addSidebarItem({
    id: BOARD,
    title: "Paseo Kanban",
    icon: "SquareKanban",
    surface: BOARD,
  });
  registerBoardPanel(client, () => ({
    id: BOARD,
    title: t("client.panel.title"),
    icon: "SquareKanban",
    context: "workspace",
    Component: WorkspaceBoard,
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
