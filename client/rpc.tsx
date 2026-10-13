import { useRpc as useHostRpc } from "@getpaseo/plugin/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import { useCallback, useSyncExternalStore } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import type { ZodType, input as ZodInput } from "zod";
import { t } from "../shared/i18n";
import { callWithRetry } from "./rpc-policy";

let pending = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function updating(active: boolean) { pending += active ? 1 : -1; for (const listener of listeners) listener(); }
const snapshot = () => pending > 0;
export function RpcUpdateNotice({ style }: { style?: StyleProp<TextStyle> }) {
  const active = useSyncExternalStore(subscribe, snapshot, snapshot);
  return active ? <Text testID="rpc-update-notice" accessibilityLiveRegion="polite" style={style}>{t("rpc.update.pending")}</Text> : null;
}
/** Keep the SDK's schema validation and stable hook identity, while sharing a conservative retry policy. */
export function useRpc<I extends ZodType, O extends ZodType>(contract: PluginRpcContract<I, O>) {
  const invoke = useHostRpc(contract);
  return useCallback((input: ZodInput<I>) => callWithRetry(contract.name, input, () => invoke(input), updating), [contract, invoke]);
}
