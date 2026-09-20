import { useState, useEffect } from 'react';
import { query } from '@/db/client';
import { useSettings } from '@/context/SettingsContext';
import { formatEgp, formatQuantity } from '@/lib/money';
import { generateReceiptHtml, printHtml, getPrinters, type PrinterInfo } from '@/lib/print';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { Printer, Loader2 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

interface ReceiptData {
  sale: {
    id: number;
    invoice_number: string;
    created_at: string;
    subtotal: number;
    discount_amount: number;
    total: number;
    payment_method: string;
    cashier_name: string;
    customer_name: string | null;
  };
  items: Array<{
    product_name: string;
    quantity: number;
    unit_price: number;
    discount_amount: number;
    line_total: number;
  }>;
}

export function Receipt({ saleId, onClose }: { saleId: number; onClose: () => void }) {
  const { get } = useSettings();
  const { isArabic } = useLanguage();
  const [data, setData] = useState<ReceiptData | null>(null);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState<string>('');
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    (async () => {
      const saleRes = await query(
        `SELECT s.*, u.display_name as cashier_name, c.name as customer_name
         FROM sales s
        JOIN public_users u ON s.cashier_id = u.id
         LEFT JOIN customers c ON s.customer_id = c.id
         WHERE s.id = $1`,
        [saleId]
      );
      const itemsRes = await query(
        'SELECT product_name, quantity, unit_price, discount_amount, line_total FROM sale_items WHERE sale_id = $1',
        [saleId]
      );
      if (saleRes.rows.length > 0) {
        setData({
          sale: saleRes.rows[0] as ReceiptData['sale'],
          items: itemsRes.rows as ReceiptData['items'],
        });
      }
      // Load printers
      const printerList = await getPrinters();
      setPrinters(printerList);
      const defaultPrinter = printerList.find((p) => p.isDefault);
      setSelectedPrinter(defaultPrinter?.name || printerList[0]?.name || '');
    })();
  }, [saleId]);

  if (!data) {
    return (
      <Modal open onClose={onClose} title="Receipt" size="md" footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="animate-spin text-slate-400" size={24} />
        </div>
      </Modal>
    );
  }

  const storeName = get('store_name', 'ELAKRAMMEN');
  const storeAddress = get('store_address', '');
  const storePhone = get('store_phone', '');
  const receiptFooter = get('receipt_footer', 'Thank you for shopping with us!');
  const date = new Date(data.sale.created_at);
  const discountPercent = data.sale.subtotal > 0 ? (data.sale.discount_amount / data.sale.subtotal) * 100 : 0;
  const showSpecialDiscount = discountPercent > 10;

  const handlePrint = async () => {
    setPrinting(true);
    const html = generateReceiptHtml({
      storeName,
      storeAddress,
      storePhone,
      receiptFooter,
      invoiceNumber: data.sale.invoice_number,
      date,
      cashierName: data.sale.cashier_name,
      customerName: data.sale.customer_name,
      items: data.items,
      subtotal: data.sale.subtotal,
      discountAmount: data.sale.discount_amount,
      total: data.sale.total,
      paymentMethod: data.sale.payment_method,
      language: isArabic ? 'ar' : 'en',
    });

    const result = await printHtml(html, {
      silent: !!selectedPrinter,
      printerName: selectedPrinter || undefined,
      pageSize: { width: 80000, height: 297000 },
      margins: { marginType: 'none' },
    });

    if (result.success) {
      toast('success', 'Receipt sent to printer');
      onClose();
    } else {
      toast('error', result.error || 'Printing failed');
    }
    setPrinting(false);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Receipt Preview"
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={handlePrint} disabled={printing}>
            {printing ? <Loader2 size={18} className="animate-spin" /> : <Printer size={18} />}
            {printing ? 'Printing...' : 'Print Receipt'}
          </Button>
        </>
      }
    >
      {/* Printer selection */}
      {printers.length > 0 && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-slate-700 mb-1">Printer</label>
          <select
            value={selectedPrinter}
            onChange={(e) => setSelectedPrinter(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          >
            {printers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.displayName || p.name} {p.isDefault ? '(Default)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Receipt preview */}
      <div className="bg-white p-4 font-mono text-sm text-slate-900 rounded-lg border border-slate-200" style={{ maxWidth: '320px', margin: '0 auto' }}>
        <div className="text-center mb-4">
          <h2 className="text-xl font-bold">{storeName}</h2>
          {storeAddress && <p className="text-xs mt-1">{storeAddress}</p>}
          {storePhone && <p className="text-xs">Tel: {storePhone}</p>}
        </div>

        <div className="border-t border-dashed border-slate-300 my-3" />

        <div className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span>Invoice:</span>
            <span className="font-bold">{data.sale.invoice_number}</span>
          </div>
          <div className="flex justify-between">
            <span>Date:</span>
            <span>{date.toLocaleDateString(isArabic ? 'ar-EG' : 'en-US')}</span>
          </div>
          <div className="flex justify-between">
            <span>Time:</span>
            <span>{date.toLocaleTimeString(isArabic ? 'ar-EG' : 'en-US')}</span>
          </div>
          <div className="flex justify-between">
            <span>Cashier:</span>
            <span>{data.sale.cashier_name}</span>
          </div>
          {data.sale.customer_name && (
            <div className="flex justify-between">
              <span>Customer:</span>
              <span>{data.sale.customer_name}</span>
            </div>
          )}
        </div>

        <div className="border-t border-dashed border-slate-300 my-3" />

        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-300">
              <th className="text-left py-1">Item</th>
              <th className="text-center py-1">Qty</th>
              <th className="text-right py-1">Price</th>
              <th className="text-right py-1">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, i) => (
              <tr key={i} className="border-b border-slate-100">
                <td className="py-1">{item.product_name}</td>
                <td className="text-center py-1">{formatQuantity(item.quantity)}</td>
                <td className="text-right py-1">{formatEgp(item.unit_price)}</td>
                <td className="text-right py-1">{formatEgp(item.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="border-t border-dashed border-slate-300 my-3" />

        <div className="space-y-1 text-xs">
          {Number(data.sale.discount_amount) > 0 && (
            <>
              <div className="flex justify-between">
                <span>Subtotal:</span>
                <span>{formatEgp(data.sale.subtotal)}</span>
              </div>
              <div className="flex justify-between text-red-600">
                <span>Discount:</span>
                <span>-{formatEgp(data.sale.discount_amount)}</span>
              </div>
              {showSpecialDiscount && (
                <div className="flex justify-between text-red-600 italic">
                  <span>{isArabic ? 'خصم خاص' : 'Special Discount'}</span>
                </div>
              )}
            </>
          )}
          <div className="flex justify-between text-base font-bold border-t border-slate-300 pt-1 mt-1">
            <span>TOTAL:</span>
            <span>{formatEgp(data.sale.total)}</span>
          </div>
          <div className="flex justify-between mt-2">
            <span>Payment:</span>
            <span>{data.sale.payment_method}</span>
          </div>
        </div>

        <div className="border-t border-dashed border-slate-300 my-3" />

        <div className="text-center text-xs">
          <p>{receiptFooter}</p>
        </div>
      </div>
    </Modal>
  );
}
