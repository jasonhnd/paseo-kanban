/// <reference types="node" />
import { act } from "react";
import type { QueryClient } from "@tanstack/react-query";

/** Longest the render tests wait for reads to land on a busy machine; a passing run never spends it. */
export const SETTLE_LIMIT_MS = 10_000;
let current: QueryClient | undefined;

/** Registers the client whose in-flight reads `settle()` waits for. */
export function trackClient(client: QueryClient): QueryClient {
  current = client;
  return client;
}

/** Lets the renderer flush, then waits until every read of the tracked client has finished. */
export async function settle(): Promise<void> {
  const pause = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await pause();
  const client = current;
  if (!client) return;
  const started = Date.now();
  while (client.isFetching() > 0) {
    if (Date.now() - started > SETTLE_LIMIT_MS) throw new Error(`reads still in flight after ${Date.now() - started}ms`);
    await pause();
  }
}
