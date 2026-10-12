import type { PaseoApi } from "@getpaseo/client";

/** Keep lifecycle fallback entirely in memory; integrations run on a board event or tick. */
export function createHookBinding(initialize: (paseo: PaseoApi) => void) {
  let client: PaseoApi | null = null;
  let pending = false;
  const activate = () => {
    if (!client || !pending) return;
    initialize(client);
    pending = false;
  };
  return {
    current: () => client,
    ready: () => client !== null,
    bindMemory(paseo: PaseoApi) {
      if (client) return;
      client = paseo;
      pending = true;
    },
    bind(paseo: PaseoApi) {
      client = paseo;
      pending = true;
      activate();
    },
    activate,
  };
}
