/**
 * Normalizes Arabic text for search without changing the original value kept
 * in the database. This makes "أحمد" discoverable with "احمد", and ignores
 * common diacritics and Arabic digit variants.
 */
export function normalizeArabicSearch(value: string): string {
  return normalizeLocalizedNumber(value)
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLocaleLowerCase()
    .trim();
}

export function arabicSearchPattern(value: string): string {
  return `%${normalizeArabicSearch(value)}%`;
}

export function matchesArabicSearch(value: string | null | undefined, search: string): boolean {
  return normalizeArabicSearch(value ?? '').includes(normalizeArabicSearch(search));
}

/** SQL equivalent shared by SQLite and PGlite/PostgreSQL for searchable text columns. */
export function normalizeArabicSql(column: string): string {
  let expression = `LOWER(${column})`;
  for (const [from, to] of [
    ['أ', 'ا'], ['إ', 'ا'], ['آ', 'ا'], ['ٱ', 'ا'], ['ى', 'ي'],
    ['ة', 'ه'], ['ؤ', 'و'], ['ئ', 'ي'], ['ـ', ''],
    ['َ', ''], ['ً', ''], ['ُ', ''], ['ٌ', ''], ['ِ', ''], ['ٍ', ''], ['ْ', ''], ['ّ', ''], ['ٰ', ''],
    ['٠', '0'], ['١', '1'], ['٢', '2'], ['٣', '3'], ['٤', '4'], ['٥', '5'], ['٦', '6'], ['٧', '7'], ['٨', '8'], ['٩', '9'],
    ['۰', '0'], ['۱', '1'], ['۲', '2'], ['۳', '3'], ['۴', '4'], ['۵', '5'], ['۶', '6'], ['۷', '7'], ['۸', '8'], ['۹', '9'],
  ] as const) {
    expression = `REPLACE(${expression}, '${from}', '${to}')`;
  }
  return expression;
}
import { normalizeLocalizedNumber } from './money';
