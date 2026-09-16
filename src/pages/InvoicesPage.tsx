import { useState, useEffect, useCallback } from 'react';
import { query } from '@/db/client';
import { formatEgp, formatQuantity } from '@/lib/money';
import { arabicSearchPattern, normalizeArabicSql } from '@/lib/search';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Receipt } from '@/components/Receipt';
import type { Sale } from '@/types';
import {
  Search, Receipt as ReceiptIcon, Printer, Eye, Calendar, RotateCw
} from 'lucide-react';

type InvoiceSale = Sale & { refunded_total: number };

export function InvoicesPage() {
  const [sales, setSales] = useState<InvoiceSale[]>([]);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [viewSaleId, setViewSaleId] = useState<number | null>(null);

  const load = useCallback(async () => {
    let sql = `
      SELECT s.*, u.display_name as cashier_name, c.name as customer_name,
             COALESCE((SELECT SUM(r.total) FROM refunds r WHERE r.sale_id = s.id), 0) as refunded_total
      FROM sales s
      JOIN public_users u ON s.cashier_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE s.status = 'completed'
    `;
    const params: unknown[] = [];
    let idx = 1;
    if (search.trim()) {
      sql += ` AND (${normalizeArabicSql('s.invoice_number')} LIKE $` + idx + ` OR ${normalizeArabicSql('c.name')} LIKE $` + idx + `)`;
      params.push(arabicSearchPattern(search));
      idx++;
    }
    if (dateFrom) {
      sql += ` AND s.created_at >= $` + idx;
      params.push(dateFrom);
      idx++;
    }
    if (dateTo) {
      sql += ` AND s.created_at <= $` + idx + ` || ' 23:59:59'`;
      params.push(dateTo);
      idx++;
    }
    sql += ` ORDER BY s.created_at DESC LIMIT 200`;
    const res = await query<InvoiceSale>(sql, params);
    setSales(res.rows);
  }, [search, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const totalAmount = sales.reduce((sum, s) => sum + s.total - s.refunded_total, 0);

  if (viewSaleId) {
    return <Receipt saleId={viewSaleId} onClose={() => setViewSaleId(null)} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Invoices</h1>
        <p className="text-sm text-slate-500 mt-0.5">View and reprint past sales invoices</p>
      </div>

      <div className="card p-4 flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            placeholder="Search by invoice number or customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-slate-300 pl-10 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" />
        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" />
        {(search || dateFrom || dateTo) && (
          <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setDateFrom(''); setDateTo(''); }}>Clear</Button>
        )}
      </div>

      <div className="card p-4 flex items-center justify-between bg-slate-50">
        <div className="flex items-center gap-2">
          <ReceiptIcon size={18} className="text-slate-600" />
          <span className="text-sm font-medium text-slate-700">{sales.length} invoices found</span>
        </div>
        <div className="text-sm font-bold text-slate-900">Total: {formatEgp(totalAmount)}</div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Invoice #</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Date</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Cashier</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Subtotal</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Discount</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Total</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Payment</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sales.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-12 text-slate-400">
                  <ReceiptIcon size={40} className="mx-auto mb-2 opacity-40" />
                  No invoices found
                </td></tr>
              ) : (
                sales.map((s) => (
                  <tr key={s.id} className="table-row-hover">
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{s.invoice_number}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{new Date(s.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{s.customer_name || 'Walk-in'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{s.cashier_name}</td>
                    <td className="px-4 py-3 text-right text-sm text-slate-600">{formatEgp(s.subtotal)}</td>
                    <td className="px-4 py-3 text-right text-sm text-red-600">{s.discount_amount > 0 ? `-${formatEgp(s.discount_amount)}` : '—'}</td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-slate-900">
                      {s.refunded_total > 0 ? (
                        <><span className="block text-xs text-slate-400 line-through">{formatEgp(s.total)}</span>{formatEgp(s.total - s.refunded_total)}</>
                      ) : formatEgp(s.total)}
                    </td>
                    <td className="px-4 py-3 text-center"><Badge variant="info">{s.payment_method}</Badge></td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Button size="sm" variant="outline" onClick={() => setViewSaleId(s.id)}>
                          <Eye size={16} /> View
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setViewSaleId(s.id)} title="Reprint invoice">
                          <RotateCw size={16} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
