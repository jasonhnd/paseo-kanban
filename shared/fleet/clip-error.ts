/** User-visible error text. The limit matches the control that shows it. */
export function clipError(error: unknown, limit: number): string {
  return String(error).slice(0, limit);
}
