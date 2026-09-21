// Printing utilities — generates HTML for receipts and barcode labels,
// then sends to the Electron main process for printing.

import { formatEgp, formatQuantity } from './money';
import { getAuthSessionId } from '@/db/client';
import { qrSvg } from './qr';

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
  status: number;
}

export async function getPrinters(): Promise<PrinterInfo[]> {
  if (typeof window !== 'undefined' && window.electronAPI) {
    const res = await window.electronAPI.print.getPrinters(getAuthSessionId());
    if (res.success && res.printers) return res.printers;
  }
  return [];
}

export async function printHtml(
  html: string,
  options?: { silent?: boolean; printerName?: string; pageSize?: { width: number; height: number }; margins?: { marginType: 'none' | 'custom'; top?: number; bottom?: number; left?: number; right?: number } }
): Promise<{ success: boolean; error?: string }> {
  if (typeof window !== 'undefined' && window.electronAPI) {
    return window.electronAPI.print.print(html, options, getAuthSessionId());
  }
  // Browser fallback — open print dialog
  const printWindow = window.open('', '_blank');
  if (!printWindow) return { success: false, error: 'Pop-up blocked' };
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.print();
  return { success: true };
}

// ─── Receipt HTML ─────────────────────────────────────────

// ─── Receipt layout (margins are measured per printer, see the test sheet) ───

export interface ReceiptLayout {
  paperMm: number;  // roll width
  leftMm: number;   // blank space on the LEFT edge
  rightMm: number;  // blank space on the RIGHT edge
  topMm: number;    // blank space above the first line (also used below the last line)
}

export const DEFAULT_RECEIPT_LAYOUT: ReceiptLayout = { paperMm: 80, leftMm: 5, rightMm: 5, topMm: 5 };
const LAYOUT_STORAGE_KEY = 'receipt_layout_v1';

export function sanitizeReceiptLayout(input?: Partial<ReceiptLayout> | null): ReceiptLayout {
  const d = DEFAULT_RECEIPT_LAYOUT;
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = typeof v === 'number' ? v : Number.NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const paperMm = num(input?.paperMm, d.paperMm, 40, 120);
  let leftMm = num(input?.leftMm, d.leftMm, 0, 30);
  let rightMm = num(input?.rightMm, d.rightMm, 0, 30);
  const topMm = num(input?.topMm, d.topMm, 0, 30);
  // keep at least 40mm of printable content
  const maxSides = paperMm - 40;
  if (leftMm + rightMm > maxSides) {
    const k = maxSides / (leftMm + rightMm);
    leftMm *= k; rightMm *= k;
  }
  return { paperMm, leftMm, rightMm, topMm };
}

export function loadReceiptLayout(): ReceiptLayout {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LAYOUT_STORAGE_KEY) : null;
    return sanitizeReceiptLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_RECEIPT_LAYOUT };
  }
}

export function saveReceiptLayout(layout: ReceiptLayout): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(sanitizeReceiptLayout(layout)));
  } catch {
    /* storage unavailable: layout simply is not remembered */
  }
}

// ─── Social media block (receipt footer) ──────────────────

export interface SocialLinks {
  facebookName: string;
  /** Link of the Facebook page; when valid it is printed as a QR code. */
  facebookUrl: string;
  instagramName: string;
  tiktokName: string;
}

/**
 * '' → no link. A valid http(s) link → the normalised link ("facebook.com/x" becomes
 * "https://facebook.com/x"). Anything else → null (invalid).
 */
export function normalizeSocialUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const ICON_ATTRS = 'width="4.2mm" height="4.2mm" viewBox="0 0 24 24" style="display:block;flex:none"';
const SOCIAL_ICONS = {
  facebook: `<svg xmlns="http://www.w3.org/2000/svg" ${ICON_ATTRS}><circle cx="12" cy="12" r="11" fill="#000"/><path d="M13.2 19.5v-6.3h2.1l.4-2.6h-2.5V9c0-.75.3-1.25 1.3-1.25h1.3V5.5c-.25 0-1-.1-1.9-.1-1.9 0-3.2 1.15-3.2 3.3v1.9H8.6v2.6h2.1v6.3z" fill="#fff"/></svg>`,
  instagram: `<svg xmlns="http://www.w3.org/2000/svg" ${ICON_ATTRS}><rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="none" stroke="#000" stroke-width="2"/><circle cx="12" cy="12" r="4.3" fill="none" stroke="#000" stroke-width="2"/><circle cx="17.4" cy="6.6" r="1.3" fill="#000"/></svg>`,
  tiktok: `<svg xmlns="http://www.w3.org/2000/svg" ${ICON_ATTRS}><path d="M14.5 3v11.2a3.6 3.6 0 1 1-3.6-3.6" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 3c.3 2.6 2 4.4 4.8 4.7" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

/** HTML for the social block. Inline styles only, so the same markup is used for printing and for the on-screen preview. */
export function socialFooterHtml(social: SocialLinks | undefined, language: 'ar' | 'en' = 'en'): string {
  if (!social) return '';
  const row = (icon: string, name: string) => name.trim()
    ? `<div dir="auto" style="display:flex;align-items:center;justify-content:center;gap:1.5mm;margin:1.2mm 0;font-size:11px;">${icon}<span dir="auto">${escapeHtml(name.trim())}</span></div>`
    : '';
  const rows = row(SOCIAL_ICONS.facebook, social.facebookName)
    + row(SOCIAL_ICONS.instagram, social.instagramName)
    + row(SOCIAL_ICONS.tiktok, social.tiktokName);

  const url = normalizeSocialUrl(social.facebookUrl);
  const qr = url ? qrSvg(url) : null;
  const caption = language === 'ar' ? 'امسح الكود لزيارة صفحتنا على فيسبوك' : 'Scan to visit our Facebook page';
  const qrBlock = qr
    ? `<div style="text-align:center;margin-top:2mm;"><div style="font-size:10px;margin-bottom:1mm;" dir="auto">${caption}</div><div style="display:inline-block;line-height:0;">${qr}</div></div>`
    : '';

  return rows || qrBlock ? `<div style="margin-top:6px;">${rows}${qrBlock}</div>` : '';
}

export interface ReceiptData {
  language?: 'ar' | 'en';
  layout?: Partial<ReceiptLayout>;
  storeName: string;
  storeAddress: string;
  storePhone: string;
  receiptFooter: string;
  social?: SocialLinks;
  invoiceNumber: string;
  date: Date;
  cashierName: string;
  customerName: string | null;
  items: Array<{
    product_name: string;
    quantity: number;
    unit_price: number;
    discount_amount: number;
    line_total: number;
  }>;
  subtotal: number;
  discountAmount: number;
  total: number;
  paymentMethod: string;
}

export function generateReceiptHtml(data: ReceiptData): string {
  const isArabic = data.language === 'ar';
  const layout = sanitizeReceiptLayout(data.layout);
  const labels = isArabic ? {
    phone: 'هاتف', invoice: 'الفاتورة', date: 'التاريخ', time: 'الوقت', cashier: 'الكاشير', customer: 'العميل',
    item: 'الصنف', quantity: 'الكمية', price: 'السعر', total: 'الإجمالي', discount: 'الخصم', subtotal: 'الإجمالي قبل الخصم',
    payment: 'الدفع',
  } : {
    phone: 'Tel', invoice: 'Invoice', date: 'Date', time: 'Time', cashier: 'Cashier', customer: 'Customer',
    item: 'Item', quantity: 'Qty', price: 'Price', total: 'Total', discount: 'Discount', subtotal: 'Subtotal',
    payment: 'Payment',
  };
  const paymentMethod = isArabic
    ? ({ Cash: 'نقدي', 'Card / Visa': 'بطاقة / فيزا', Instapay: 'إنستاباي', Other: 'أخرى' }[data.paymentMethod] ?? data.paymentMethod)
    : data.paymentMethod;
  const locale = isArabic ? 'ar-EG' : 'en-US';
  const discountPercent = data.subtotal > 0 ? (data.discountAmount / data.subtotal) * 100 : 0;
  const showSpecialDiscount = discountPercent > 10;
  const specialDiscountLabel = isArabic ? 'خصم خاص' : 'Special Discount';
  const itemsHtml = data.items.map((item) => `
    <tr>
      <td class="item-name">${escapeHtml(item.product_name)}</td>
      <td class="qty">${formatQuantity(item.quantity)}</td>
      <td class="price">${formatEgp(item.unit_price)}</td>
      <td class="total">${formatEgp(item.line_total)}</td>
    </tr>
    ${item.discount_amount > 0 ? `<tr><td colspan="4" class="discount-line">${labels.discount}: -${formatEgp(item.discount_amount)}</td></tr>` : ''}
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* NOTE: no "size" in @page. "size: 80mm" means an 80mm x 80mm page and splits the
     receipt over two sheets. The real paper size (80mm wide) is passed by Receipt.tsx. */
  @page { margin: 0; }
  html { margin: 0; padding: 0; }
  body {
    box-sizing: border-box;
    font-family: ${isArabic ? "Tahoma, Arial, sans-serif" : "'Courier New', monospace"};
    font-size: 12px;
    color: #000;
    width: ${layout.paperMm}mm;            /* full roll width ... */
    margin: 0;
    /* ... blank space is made with PHYSICAL paddings (left/right never flip in RTL) */
    padding: ${layout.topMm}mm ${layout.rightMm}mm ${layout.topMm}mm ${layout.leftMm}mm;
    direction: ${isArabic ? 'rtl' : 'ltr'};
    overflow-wrap: anywhere;
  }
  .header { text-align: center; margin-bottom: 8px; }
  .header h2 { font-size: 18px; font-weight: bold; margin: 0; }
  .header p { font-size: 11px; margin: 2px 0; }
  .divider { border-top: 1px dashed #000; margin: 6px 0; }
  .info { font-size: 11px; }
  .info-row { display: flex; justify-content: space-between; gap: 6px; margin: 1px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; }
  th { text-align: start; border-bottom: 1px solid #000; padding: 2px 0; white-space: nowrap; }
  .item-col { width: 30%; } .qty-col { width: 14%; } .price-col { width: 28%; } .total-col { width: 28%; }
  .qty { text-align: center; }
  .price, .total { text-align: end; }
  .item-name { padding: 2px 0; }
  .discount-line { font-size: 10px; color: #555; text-align: end; padding: 0; }
  .totals { font-size: 12px; margin-top: 4px; }
  .total-row { font-size: 14px; font-weight: bold; border-top: 1px solid #000; padding-top: 4px; margin-top: 4px; }
  .footer { text-align: center; font-size: 10px; margin-top: 8px; }
</style>
</head>
<body>
  <div class="header">
    <h2>${escapeHtml(data.storeName)}</h2>
    ${data.storeAddress ? `<p>${escapeHtml(data.storeAddress)}</p>` : ''}
    ${data.storePhone ? `<p>${labels.phone}: ${escapeHtml(data.storePhone)}</p>` : ''}
  </div>
  <div class="divider"></div>
  <div class="info">
    <div class="info-row"><span>${labels.invoice}:</span><span><b>${escapeHtml(data.invoiceNumber)}</b></span></div>
    <div class="info-row"><span>${labels.date}:</span><span>${data.date.toLocaleDateString(locale)}</span></div>
    <div class="info-row"><span>${labels.time}:</span><span>${data.date.toLocaleTimeString(locale)}</span></div>
    <div class="info-row"><span>${labels.cashier}:</span><span>${escapeHtml(data.cashierName)}</span></div>
    ${data.customerName ? `<div class="info-row"><span>${labels.customer}:</span><span>${escapeHtml(data.customerName)}</span></div>` : ''}
  </div>
  <div class="divider"></div>
  <table>
    <colgroup><col class="item-col"><col class="qty-col"><col class="price-col"><col class="total-col"></colgroup>
    <thead>
      <tr><th>${labels.item}</th><th class="qty">${labels.quantity}</th><th class="price">${labels.price}</th><th class="total">${labels.total}</th></tr>
    </thead>
    <tbody>${itemsHtml}</tbody>
  </table>
  <div class="divider"></div>
  <div class="totals">
    ${Number(data.discountAmount) > 0 ? `<div class="info-row"><span>${labels.subtotal}:</span><span>${formatEgp(data.subtotal)}</span></div><div class="info-row" style="color:#555;"><span>${labels.discount}:</span><span>-${formatEgp(data.discountAmount)}</span></div>${showSpecialDiscount ? `<div class="info-row" style="color:#555; font-style:italic;"><span>${specialDiscountLabel}</span><span></span></div>` : ''}` : ''}
    <div class="info-row total-row"><span>${labels.total}:</span><span>${formatEgp(data.total)}</span></div>
    <div class="info-row" style="margin-top:4px;"><span>${labels.payment}:</span><span>${escapeHtml(paymentMethod)}</span></div>
  </div>
  <div class="divider"></div>
  <div class="footer">
    <p dir="auto">${escapeHtml(data.receiptFooter)}</p>
    ${socialFooterHtml(data.social, isArabic ? 'ar' : 'en')}
  </div>
</body>
</html>`;
}

// ─── Printer test sheet ───────────────────────────────────
// Prints a "staircase" of numbers: row N has the number N written N millimetres
// from the LEFT edge and N millimetres from the RIGHT edge of the paper.
// The first number that is fully visible on each side = how many mm that side cuts off.

export function generateCalibrationHtml(language: 'ar' | 'en' = 'ar', paperMm = 80): string {
  const isArabic = language === 'ar';
  const rows = Array.from({ length: 16 }, (_, i) =>
    `<div class="row"><span class="l" style="left:${i}mm">${i}</span><span class="r" style="right:${i}mm">${i}</span></div>`
  ).join('');
  const title = isArabic ? 'ورقة اختبار الطابعة' : 'Printer test sheet';
  const lines = isArabic
    ? ['الرقم = المسافة بالمليمتر من حافة الورقة.', 'اقرأ أول رقم يظهر كاملاً على اليسار، ثم على اليمين.', 'ضع الرقم زائد واحد في خانة الهامش لكل جانب بالبرنامج.']
    : ['Number = distance in mm from the paper edge.', 'Read the first fully visible number on the left, then on the right.', 'Enter that number plus 1 in the matching margin box in the app.'];
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { margin: 0; }
  html { margin: 0; padding: 0; }
  body { box-sizing: border-box; width: ${paperMm}mm; margin: 0; padding: 4mm 0; font-family: Arial, Tahoma, sans-serif; color: #000; direction: ltr; }
  .title { text-align: center; font-size: 4.2mm; font-weight: bold; margin: 0 0 1mm; }
  .note { text-align: center; font-size: 2.9mm; margin: 0 auto 2mm; padding: 0 16mm; direction: ${isArabic ? 'rtl' : 'ltr'}; }
  .frame { width: ${paperMm}mm; box-sizing: border-box; border-left: 0.5mm solid #000; border-right: 0.5mm solid #000; }
  .row { position: relative; height: 4.6mm; line-height: 4.6mm; font-size: 3.4mm; }
  .row span { position: absolute; top: 0; }
  .edge { border-top: 0.5mm solid #000; }
</style>
</head>
<body>
  <p class="title">${title}</p>
  ${lines.map((l) => `<p class="note">${l}</p>`).join('')}
  <div class="frame edge">${rows}</div>
  <div class="edge"></div>
</body>
</html>`;
}

// ─── Barcode Label HTML ───────────────────────────────────

export interface LabelData {
  productName: string;
  barcode: string;
  price: number;
  storeName: string;
  size?: string;
  color?: string;
}

export function generateLabelHtml(data: LabelData, copies: number = 1): string {
  const variantInfo = [data.size, data.color].filter(Boolean).join(' / ');
  const labelHtml = `
    <div class="label">
      <div class="label-store">${escapeHtml(data.storeName)}</div>
      <div class="label-name">${escapeHtml(data.productName)}</div>
      ${variantInfo ? `<div class="label-variant">${escapeHtml(variantInfo)}</div>` : ''}
      <div class="label-barcode">${generateBarcodeSvg(data.barcode)}</div>
      <div class="label-price">${formatEgp(data.price)}</div>
    </div>
  `;
  const allLabels = Array(copies).fill(labelHtml).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: 40mm 25mm; margin: 0; }
  body { margin: 0; padding: 0; }
  .label {
    width: 40mm;
    height: 25mm;
    text-align: center;
    font-family: Arial, sans-serif;
    overflow: hidden;
    page-break-after: always;
    box-sizing: border-box;
    padding: 1mm;
  }
  .label-store { font-size: 7px; font-weight: bold; }
  .label-name { font-size: 8px; margin: 1px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .label-barcode { margin: 1px 0; }
  .label-barcode svg { width: 35mm; height: 10mm; }
  .label-price { font-size: 10px; font-weight: bold; }
  .label-variant { font-size: 7px; color: #555; margin: 0; }
</style>
</head>
<body>${allLabels}</body>
</html>`;
}

// ─── Barcode SVG generator (Code128-like visual barcode) ────
// Generates a simple barcode-style SVG using the barcode text.
// For production use, this creates a visual barcode pattern from the digits.
function generateBarcodeSvg(barcode: string): string {
  const digits = barcode.replace(/[^0-9]/g, '').padEnd(12, '0').slice(0, 12);
  let bars = '';
  let x = 0;
  const barWidth = 2;
  // Start guard
  bars += `<rect x="${x}" y="0" width="${barWidth}" height="40" fill="#000"/>`;
  x += barWidth * 2;
  // Encode each digit as a pattern of bars
  for (let i = 0; i < digits.length; i++) {
    const d = parseInt(digits[i], 10);
    const pattern = digitPattern(d);
    for (let j = 0; j < 4; j++) {
      const w = pattern[j];
      bars += `<rect x="${x}" y="0" width="${barWidth * w}" height="40" fill="${j % 2 === 0 ? '#000' : '#fff'}"/>`;
      x += barWidth * w;
    }
  }
  // End guard
  bars += `<rect x="${x}" y="0" width="${barWidth}" height="40" fill="#000"/>`;
  const totalWidth = x + barWidth;
  return `<svg viewBox="0 0 ${totalWidth} 40" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}

function digitPattern(d: number): number[] {
  // Simple width patterns for each digit (0-9)
  const patterns: Record<number, number[]> = {
    0: [3, 2, 1, 1], 1: [2, 2, 2, 1], 2: [2, 1, 2, 2], 3: [1, 4, 1, 1],
    4: [1, 1, 3, 2], 5: [1, 2, 3, 1], 6: [1, 1, 1, 4], 7: [1, 3, 1, 2],
    8: [1, 2, 1, 3], 9: [3, 1, 1, 2],
  };
  return patterns[d] || [1, 1, 1, 1];
}

// ─── Helpers ──────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
