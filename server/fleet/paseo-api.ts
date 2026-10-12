import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/** The host-owned API, obtained through the supported server SDK type boundary. */
export type PaseoApi = PluginHandlerContext["paseo"];
