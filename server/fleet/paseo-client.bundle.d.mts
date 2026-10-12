import type { PaseoApi } from "./paseo-api";

export interface DaemonClientOptions {
  url: string;
  clientId: string;
  connectTimeoutMs: number;
  reconnect: { enabled: boolean };
}

export function createPaseoClient(options: DaemonClientOptions): PaseoApi & {
  connect(): Promise<void>;
  close(): Promise<void>;
};
