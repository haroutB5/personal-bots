/** Money in the usage views: cents under $1,000, a rounded thousands form above it. */
export function formatUsd(usd: number): string {
  const value = Number.isFinite(usd) && usd > 0 ? usd : 0;
  if (value === 0) return "$0.00";
  if (value < 0.005) return "<$0.01";
  if (value < 1000) return `$${value.toFixed(2)}`;
  if (value < 10_000) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${(value / 1000).toFixed(1)}k`;
}
