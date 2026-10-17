/** Allocated-byte labels. GiB is 1024^3. The unit text is the same in every language. */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const units = [
    [1024 ** 3, "GiB"],
    [1024 ** 2, "MiB"],
    [1024, "KiB"],
  ] as const;
  for (const [size, unit] of units) {
    if (value < size) continue;
    const scaled = Math.round((value / size) * 100) / 100;
    const text = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return `${text} ${unit}`;
  }
  return `${Math.round(value)} B`;
}
