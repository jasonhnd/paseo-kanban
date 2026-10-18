import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { t } from "../shared/i18n";

/** Validate on the owning daemon, then navigate only inside the current client. */
export async function openAgentInHost(
  agentId: string,
  serverId: string,
  navigation: PluginSurfaceProps["navigation"],
  validate: (input: { agentId: string }) => Promise<{ url: string | null; message: string }>,
): Promise<void> {
  if (!navigation || !serverId) throw new Error(t("board.navigationUnavailable"));
  // This read preserves the workspace/cwd checks without running `paseo agent open`.
  const result = await validate({ agentId });
  if (!result.url) throw new Error(result.message);
  await navigation.openAgent({ agentId, serverId });
}
