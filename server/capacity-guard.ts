/// <reference types="node" />
// Red stub: the regression calls this API and expects a pause. The real guard replaces this file.

export interface CapacityProbe {
  roots?: string[];
  du?: (path: string) => number;
  free?: (path: string) => number;
  fresh?: boolean;
}

export interface CapacityRefresh {
  now?: Date;
  config?: unknown;
  send?: (agentId: string, text: string) => Promise<void> | void;
  notify?: boolean;
}

export function resetCapacityForTests(): void {}

export function setCapacityProbeForTests(_probe: CapacityProbe | null): void {}

export async function refreshCapacityGuard(_input: CapacityRefresh = {}): Promise<void> {}

export function capacityHoldReason(): string | null {
  return null;
}

export function capacityFindings(): Array<{ id: string; severity: string; evidence: string }> {
  return [];
}

export function capacityAlertSuppressId(): string | null {
  return null;
}

export function markCapacityLeaderAlerted(): void {}

export function recordCardWorkBytes(_taskId: number): void {}
