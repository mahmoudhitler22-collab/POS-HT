// Money utilities — all amounts stored as integer piasters (1 EGP = 100 piasters)
// This avoids floating-point rounding errors in financial calculations.

export const PIASTERS_PER_POUND = 100;

/**
 * Convert Arabic-Indic/Persian digits and separators to the form JavaScript
 * understands.  A cashier can therefore enter ١٢٫٥٠ just as they can 12.50.
 */
export function normalizeLocalizedNumber(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٬,]/g, '')
    .replace(/٫/g, '.');
}

export function parseLocalizedNumber(value: number | string): number {
  if (typeof value === 'number') return value;
  return Number(normalizeLocalizedNumber(value).trim());
}

function displayLocale(): string {
  const documentRef = (globalThis as { document?: { documentElement?: { lang?: string } } }).document;
  return documentRef?.documentElement?.lang === 'ar' ? 'ar-EG' : 'en-US';
}

export function toPiasters(egp: number | string): number {
  const n = parseLocalizedNumber(egp);
  return Math.round(n * PIASTERS_PER_POUND);
}

export function toEgp(piasters: number): number {
  return piasters / PIASTERS_PER_POUND;
}

export function formatEgp(piasters: number): string {
  const egp = toEgp(piasters);
  return `${egp.toLocaleString(displayLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatEgpWithSymbol(piasters: number, symbol = 'E£'): string {
  return `${symbol} ${formatEgp(piasters)}`;
}

export function formatQuantity(qty: number): string {
  return qty.toLocaleString(displayLocale(), {
    minimumFractionDigits: Number.isInteger(qty) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
