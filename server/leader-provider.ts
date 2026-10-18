/** Built-in provider and the optional dedicated memory-bridge launch command. */
export function isHermesLeaderProvider(provider: string): boolean {
  return provider === "hermes" || provider === "hermes-leader";
}
