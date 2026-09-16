// Money utilities — all amounts stored as integer piasters (1 EGP = 100 piasters)
// This avoids floating-point rounding errors in financial calculations.

export const PIASTERS_PER_POUND = 100;

export function toPiasters(egp: number | string): number {
  const n = typeof egp === 'string' ? parseFloat(egp) : egp;
  return Math.round(n * PIASTERS_PER_POUND);
}

export function toEgp(piasters: number): number {
  return piasters / PIASTERS_PER_POUND;
}

export function formatEgp(piasters: number): string {
  const egp = toEgp(piasters);
  return `${egp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatEgpWithSymbol(piasters: number, symbol = 'E£'): string {
  return `${symbol} ${formatEgp(piasters)}`;
}

export function formatQuantity(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
}
