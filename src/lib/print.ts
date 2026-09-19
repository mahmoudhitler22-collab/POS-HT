// Printing utilities — generates HTML for receipts and barcode labels,
// then sends to the Electron main process for printing.

import { formatEgp, formatQuantity } from './money';
import { getAuthSessionId } from '@/db/client';

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
  options?: { silent?: boolean; printerName?: string; pageSize?: { width: number; height: number } }
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

export interface ReceiptData {
  language?: 'ar' | 'en';
  storeName: string;
  storeAddress: string;
  storePhone: string;
  receiptFooter: string;
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
  const labels = isArabic ? {
    phone: 'هاتف', invoice: 'الفاتورة', date: 'التاريخ', time: 'الوقت', cashier: 'الكاشير', customer: 'العميل',
    item: 'الصنف', quantity: 'الكمية', price: 'السعر', total: 'الإجمالي', discount: 'الخصم', subtotal: 'الإجمالي قبل الخصم',
    payment: 'الدفع', generated: 'إيصال صادر من النظام',
  } : {
    phone: 'Tel', invoice: 'Invoice', date: 'Date', time: 'Time', cashier: 'Cashier', customer: 'Customer',
    item: 'Item', quantity: 'Qty', price: 'Price', total: 'Total', discount: 'Discount', subtotal: 'Subtotal',
    payment: 'Payment', generated: 'Computer-generated receipt',
  };
  const paymentMethod = isArabic
    ? ({ Cash: 'نقدي', 'Card / Visa': 'بطاقة / فيزا', Instapay: 'إنستاباي', Other: 'أخرى' }[data.paymentMethod] ?? data.paymentMethod)
    : data.paymentMethod;
  const locale = isArabic ? 'ar-EG' : 'en-US';
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
  @page { margin: 0; }
  body {
    font-family: ${isArabic ? "Tahoma, Arial, sans-serif" : "'Courier New', monospace"};
    font-size: 12px;
    color: #000;
    width: 80mm;
    margin: 0 auto;
    padding: 4mm;
    direction: ${isArabic ? 'rtl' : 'ltr'};
  }
  .header { text-align: center; margin-bottom: 8px; }
  .header h2 { font-size: 18px; font-weight: bold; margin: 0; }
  .header p { font-size: 11px; margin: 2px 0; }
  .divider { border-top: 1px dashed #000; margin: 6px 0; }
  .info { font-size: 11px; }
  .info-row { display: flex; justify-content: space-between; margin: 1px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { text-align: left; border-bottom: 1px solid #000; padding: 2px 0; }
  .qty { text-align: center; }
  .price, .total { text-align: right; }
  .item-name { padding: 2px 0; }
  .discount-line { font-size: 10px; color: #555; text-align: right; padding: 0; }
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
    <thead>
      <tr><th>${labels.item}</th><th class="qty">${labels.quantity}</th><th class="price">${labels.price}</th><th class="total">${labels.total}</th></tr>
    </thead>
    <tbody>${itemsHtml}</tbody>
  </table>
  <div class="divider"></div>
  <div class="totals">
    <div class="info-row"><span>${labels.subtotal}:</span><span>${formatEgp(data.subtotal)}</span></div>
    ${data.discountAmount > 0 ? `<div class="info-row" style="color:#555;"><span>${labels.discount}:</span><span>-${formatEgp(data.discountAmount)}</span></div>` : ''}
    <div class="info-row total-row"><span>${labels.total}:</span><span>${formatEgp(data.total)}</span></div>
    <div class="info-row" style="margin-top:4px;"><span>${labels.payment}:</span><span>${escapeHtml(paymentMethod)}</span></div>
  </div>
  <div class="divider"></div>
  <div class="footer">
    <p>${escapeHtml(data.receiptFooter)}</p>
    <p style="color:#999;">${labels.generated}</p>
  </div>
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
