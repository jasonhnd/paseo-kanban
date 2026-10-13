import { useQuery as useHostQuery, useQueryClient, type DefaultError, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";
import { PluginUpdateError } from "./rpc-policy";

/** The RPC layer already exhausted its retry budget. Do not multiply that window with query retries. */
export function useQuery<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData, TKey extends QueryKey = QueryKey>(options: UseQueryOptions<TQueryFnData, TError, TData, TKey>) {
  const client = useQueryClient();
  const configured = (options.retry ?? client.getQueryDefaults(options.queryKey).retry ?? client.getDefaultOptions().queries?.retry ?? 3) as boolean | number | ((count: number, error: TError) => boolean);
  return useHostQuery({ ...options, retry: (count, error) => {
    if (error instanceof PluginUpdateError) return false;
    if (typeof configured === "function") return configured(count, error);
    return configured === true || (typeof configured === "number" && count < configured);
  } });
}
