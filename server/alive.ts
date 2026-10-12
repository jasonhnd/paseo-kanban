/// <reference types="node" />
import { agentRecordUsable } from "./open";

let aliveCheck: (agentId: string) => boolean = agentRecordUsable;

export function setAgentAliveCheck(fn: (agentId: string) => boolean): void {
  aliveCheck = fn;
}

export function resetAgentAliveCheck(): void {
  aliveCheck = agentRecordUsable;
}

export function isAgentAlive(agentId: string): boolean {
  return aliveCheck(agentId);
}
