import { useState, useEffect, useCallback } from 'react';
import { getAuthSessionId, query, transaction } from '@/db/client';
import { useAuth } from '@/context/AuthContext';
import { logAudit } from '@/lib/audit';
import { formatEgp, formatQuantity, parseLocalizedNumber } from '@/lib/money';
import { arabicSearchPattern, normalizeArabicSql } from '@/lib/search';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ui/Modal';
import type { Sale, SaleItem, Refund } from '@/types';
import {
  Undo2, Search, Receipt, ArrowLeft
} from 'lucide-react';

export function RefundsPage() {
  const { user } = useAuth();
  const [view, setView] = useState<'list' | 'detail' | 'history'>('list');
  const [search, setSearch] = useState('');
  const [sales, setSales] = useState<Sale[]>([]);
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);
  const [existingRefunds, setExistingRefunds] = useState<Refund[]>([]);
  const [refundSelection, setRefundSelection] = useState<Record<number, { qty: number; selected: boolean }>>({});
  const [refundReason, setRefundReason] = useState('');
  const [confirmRefund, setConfirmRefund] = useState(false);
  const [refunds, setRefunds] = useState<Refund[]>([]);

  const loadSales = useCallback(async () => {
    let sql = `
      SELECT s.*, u.display_name as cashier_name, c.name as customer_name
      FROM sales s
      JOIN public_users u ON s.cashier_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE s.status = 'completed'
    `;
    const params: unknown[] = [];
    if (search.trim()) {
      sql += ` AND (${normalizeArabicSql('s.invoice_number')} LIKE $1 OR ${normalizeArabicSql('c.name')} LIKE $1)`;
      params.push(arabicSearchPattern(search));
    }
    sql += ` ORDER BY s.created_at DESC LIMIT 50`;
    const res = await query<Sale>(sql, params);
    setSales(res.rows);
  }, [search]);

  const loadRefunds = useCallback(async () => {
    const res = await query<Refund>(
      `SELECT r.*, s.invoice_number, u.display_name as cashier_name
       FROM refunds r
       JOIN sales s ON r.sale_id = s.id
       JOIN public_users u ON r.cashier_id = u.id
       ORDER BY r.created_at DESC LIMIT 100`
    );
    setRefunds(res.rows as Refund[]);
  }, []);

  useEffect(() => {
    if (view === 'list') loadSales();
    if (view === 'history') loadRefunds();
  }, [view, loadSales, loadRefunds]);

  const openSale = async (sale: Sale) => {
    setSelectedSale(sale);
    const itemsRes = await query<SaleItem>('SELECT * FROM sale_items WHERE sale_id = $1', [sale.id]);
    const refundsRes = await query<Refund>('SELECT * FROM refunds WHERE sale_id = $1', [sale.id]);
    setSaleItems(itemsRes.rows);
    setExistingRefunds(refundsRes.rows);

    // Initialize refund selection with already-refunded quantities tracked
    const init: Record<number, { qty: number; selected: boolean }> = {};
    for (const item of itemsRes.rows) {
      init[item.id] = { qty: 0, selected: false };
    }
    setRefundSelection(init);
    setView('detail');
  };

  // Calculate already-refunded quantity per sale item
  const getRefundedQty = async (saleItemId: number): Promise<number> => {
    const res = await query<{ total: string }>(
      'SELECT COALESCE(SUM(quantity), 0) as total FROM refund_items WHERE sale_item_id = $1',
      [saleItemId]
    );
    return parseFloat(res.rows[0].total);
  };

  const [refundedQtys, setRefundedQtys] = useState<Record<number, number>>({});
  useEffect(() => {
    if (saleItems.length > 0) {
      (async () => {
        const qtys: Record<number, number> = {};
        for (const item of saleItems) {
          qtys[item.id] = await getRefundedQty(item.id);
        }
        setRefundedQtys(qtys);
      })();
    }
  }, [saleItems, existingRefunds]);

  const refundableItems = saleItems.map((item) => {
    const refunded = refundedQtys[item.id] || 0;
    const refundable = item.quantity - refunded;
    return { ...item, refundedQty: refunded, refundableQty: refundable };
  });

  const selectedRefundItems = refundableItems.filter((item) => refundSelection[item.id]?.selected && refundSelection[item.id].qty > 0);
  const refundTotal = selectedRefundItems.reduce((sum, item) => {
    const sel = refundSelection[item.id];
    if (!sel || sel.qty <= 0) return sum;
    // Calculate proportional refund based on the actual price paid (after discount)
    const unitPriceAfterDiscount = item.final_price / item.quantity;
    return sum + Math.round(unitPriceAfterDiscount * sel.qty);
  }, 0);

  const handleProcessRefund = async () => {
    if (!selectedSale || selectedRefundItems.length === 0) return;

    let processedRefundTotal = refundTotal;
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.db.processRefund({
          saleId: selectedSale.id,
          reason: refundReason,
          items: selectedRefundItems.map((item) => ({
            saleItemId: item.id,
            quantity: refundSelection[item.id].qty,
          })),
        }, getAuthSessionId());
        if (!result.success || !result.refund) throw new Error(result.error || 'Refund failed');
        toast('success', `Refund processed: ${formatEgp(result.refund.total)}`);
        setConfirmRefund(false);
        setView('list');
        setSelectedSale(null);
        loadSales();
        return;
      }

      await transaction(async (tx) => {
        // Re-check each line inside the transaction and allocate any rounding
        // remainder to the final refundable quantity. This prevents separate
        // partial refunds from ever adding up to more than the line's paid
        // price (for example, 101 piasters split over three units).
        const refundLines: Array<{ item: SaleItem; sel: { qty: number; selected: boolean }; refundAmount: number }> = [];
        for (const item of selectedRefundItems) {
          const sel = refundSelection[item.id];
          const previous = await tx.query<{ quantity: number | string; amount: number | string }>(
            'SELECT COALESCE(SUM(quantity), 0) as quantity, COALESCE(SUM(refund_amount), 0) as amount FROM refund_items WHERE sale_item_id = $1',
            [item.id]
          );
          const alreadyRefundedQty = Number(previous.rows[0]?.quantity ?? 0);
          const alreadyRefundedAmount = Number(previous.rows[0]?.amount ?? 0);
          const remainingQuantity = item.quantity - alreadyRefundedQty;
          const remainingAmount = item.final_price - alreadyRefundedAmount;
          if (!Number.isFinite(sel.qty) || sel.qty <= 0 || sel.qty > remainingQuantity) {
            throw new Error(`Refund quantity for ${item.product_name} exceeds the remaining refundable quantity`);
          }
          const refundAmount = sel.qty === remainingQuantity
            ? remainingAmount
            : Math.min(remainingAmount, Math.round(item.final_price * sel.qty / item.quantity));
          refundLines.push({ item, sel, refundAmount });
        }
        processedRefundTotal = refundLines.reduce((sum, line) => sum + line.refundAmount, 0);

        // Generate refund number
        const counterRes = await tx.query<{ value: string }>("SELECT value FROM settings WHERE key = 'refund_counter'");
        const counter = parseInt(counterRes.rows[0].value, 10) + 1;
        const prefix = 'RFD';
        const refundNumber = `${prefix}-${String(counter).padStart(6, '0')}`;
        await tx.exec("UPDATE settings SET value = $1 WHERE key = 'refund_counter'", [String(counter)]);

        // Create refund record
        const refundRes = await tx.query<{ id: number }>(
          `INSERT INTO refunds (refund_number, sale_id, customer_id, cashier_id, total, reason)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
           [refundNumber, selectedSale.id, selectedSale.customer_id, user!.id, processedRefundTotal, refundReason.trim()]
        );
        const refundId = refundRes.rows[0].id;

        // Create refund items and restore inventory
        for (const { item, sel, refundAmount } of refundLines) {

          await tx.exec(
            `INSERT INTO refund_items (refund_id, sale_item_id, product_id, variant_id, product_name, quantity, unit_price, refund_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [refundId, item.id, item.product_id, item.variant_id, item.product_name, sel.qty, item.unit_price, refundAmount]
          );

          // Restore the same inventory record that was reduced by the sale.
          const stockRes = item.variant_id === null
            ? await tx.query<{ quantity: number }>('SELECT quantity FROM products WHERE id = $1', [item.product_id])
            : await tx.query<{ quantity: number }>('SELECT quantity FROM product_variants WHERE id = $1 AND product_id = $2', [item.variant_id, item.product_id]);
          const prevQty = stockRes.rows[0]?.quantity;
          if (prevQty === undefined) throw new Error(`Stock record for ${item.product_name} was not found`);
          const newQty = prevQty + sel.qty;
          if (item.variant_id === null) {
            await tx.exec('UPDATE products SET quantity = $1, updated_at = datetime(\'now\') WHERE id = $2', [newQty, item.product_id]);
          } else {
            await tx.exec('UPDATE product_variants SET quantity = $1, updated_at = datetime(\'now\') WHERE id = $2', [newQty, item.variant_id]);
          }

          await tx.exec(
            `INSERT INTO inventory_movements (product_id, variant_id, quantity_change, previous_quantity, new_quantity, reason, reference_type, reference_id, user_id)
             VALUES ($1, $2, $3, $4, $5, 'Refund', 'refund', $6, $7)`,
            [item.product_id, item.variant_id, sel.qty, prevQty, newQty, refundId, user!.id]
          );
        }

        // Update customer stats and reverse loyalty points if applicable
        if (selectedSale.customer_id) {
          await tx.exec(
            `UPDATE customers SET total_purchases = total_purchases - $1 WHERE id = $2`,
            [processedRefundTotal, selectedSale.customer_id]
          );

          // Reverse loyalty points from the original sale
          const loyaltyRes = await tx.query<{ points: number; sale_id: number }>(
            'SELECT points, sale_id FROM loyalty_transactions WHERE sale_id = $1 AND points > 0',
            [selectedSale.id]
          );
          if (loyaltyRes.rows.length > 0) {
            const originalPoints = loyaltyRes.rows[0].points;
            // Calculate proportional points to reverse based on refund ratio
            const refundRatio = processedRefundTotal / selectedSale.total;
            const pointsToReverse = Math.round(originalPoints * refundRatio);
            if (pointsToReverse > 0) {
              await tx.exec(
                'UPDATE customers SET loyalty_points = MAX(0, loyalty_points - $1) WHERE id = $2',
                [pointsToReverse, selectedSale.customer_id]
              );
              await tx.exec(
                'INSERT INTO loyalty_transactions (customer_id, sale_id, refund_id, points, reason) VALUES ($1, $2, $3, $4, $5)',
                [selectedSale.customer_id, selectedSale.id, refundId, -pointsToReverse, `Refund ${refundNumber}`]
              );
            }
          }
        }
      });

      await logAudit({
        user_id: user?.id ?? null,
        action: 'refund_process',
        entity_type: 'sale',
        entity_id: selectedSale.id,
        new_value: JSON.stringify({ refundTotal: processedRefundTotal, items: selectedRefundItems.length }),
      });

      toast('success', `Refund processed: ${formatEgp(processedRefundTotal)}`);
      setConfirmRefund(false);
      setView('list');
      setSelectedSale(null);
      loadSales();
    } catch {
      toast('error', 'Failed to process refund');
    }
  };

  if (view === 'detail' && selectedSale) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <button onClick={() => setView('list')} className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900">
            <ArrowLeft size={18} /> Back to Sales
          </button>
        </div>

        <div className="card p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Invoice {selectedSale.invoice_number}</h2>
              <p className="text-sm text-slate-500 mt-1">
                {new Date(selectedSale.created_at).toLocaleString()} · Cashier: {selectedSale.cashier_name}
                {selectedSale.customer_name && ` · Customer: ${selectedSale.customer_name}`}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-slate-500">Original Total</p>
              <p className="text-2xl font-bold text-slate-900">{formatEgp(selectedSale.total)}</p>
            </div>
          </div>

          {existingRefunds.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-sm text-amber-700">
              This invoice has {existingRefunds.length} previous refund(s) totaling {formatEgp(existingRefunds.reduce((s, r) => s + r.total, 0))}
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700 mb-2">Select items to refund:</p>
            {refundableItems.map((item) => {
              const sel = refundSelection[item.id] || { qty: 0, selected: false };
              const unitPriceAfterDiscount = item.final_price / item.quantity;
              return (
                <div key={item.id} className={`flex items-center gap-4 p-3 rounded-lg border ${sel.selected ? 'border-teal-300 bg-teal-50' : 'border-slate-200'}`}>
                  <input
                    type="checkbox"
                    checked={sel.selected}
                    onChange={(e) => setRefundSelection({ ...refundSelection, [item.id]: { ...sel, selected: e.target.checked, qty: e.target.checked ? 1 : 0 } })}
                    disabled={item.refundableQty <= 0}
                    className="w-5 h-5 rounded"
                  />
                  <div className="flex-1">
                    <p className="font-medium text-slate-900">{item.product_name}</p>
                    <p className="text-xs text-slate-500">
                      Original qty: {formatQuantity(item.quantity)}
                      {item.discount_amount > 0 && ` · Discount: ${formatEgp(item.discount_amount)}`}
                      {item.refundedQty > 0 && ` · Already refunded: ${formatQuantity(item.refundedQty)}`}
                    </p>
                    <p className="text-xs text-slate-400">
                      Paid: {formatEgp(item.final_price)} ({formatEgp(Math.round(unitPriceAfterDiscount))}/unit after discount)
                    </p>
                  </div>
                  {sel.selected && (
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-slate-600">Qty:</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        min="0"
                        max={item.refundableQty}
                        step="0.01"
                        value={sel.qty}
                        onChange={(e) => {
                          const val = Math.min(parseLocalizedNumber(e.target.value) || 0, item.refundableQty);
                          setRefundSelection({ ...refundSelection, [item.id]: { ...sel, qty: val } });
                        }}
                        className="w-20 text-sm border border-slate-200 rounded px-2 py-1"
                      />
                      <span className="text-xs text-slate-500">of {formatQuantity(item.refundableQty)}</span>
                    </div>
                  )}
                  <div className="text-right w-24">
                    {sel.selected && sel.qty > 0 ? (
                      <p className="font-bold text-red-600">{formatEgp(Math.round(unitPriceAfterDiscount * sel.qty))}</p>
                    ) : (
                      <p className="text-sm text-slate-400">{formatEgp(item.final_price)}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {selectedRefundItems.length > 0 && (
            <div className="mt-6 pt-4 border-t border-slate-200 space-y-4">
              <Textarea label="Refund Reason" rows={2} value={refundReason} onChange={(e) => setRefundReason(e.target.value)} placeholder="Reason for refund..." />
              <div className="flex items-center justify-between bg-red-50 rounded-lg p-4">
                <div>
                  <p className="text-sm text-slate-600">Total Refund Amount</p>
                  <p className="text-xs text-slate-400">Calculated using actual price paid after discounts</p>
                </div>
                <p className="text-2xl font-bold text-red-600">{formatEgp(refundTotal)}</p>
              </div>
              <Button variant="danger" size="lg" onClick={() => setConfirmRefund(true)} className="w-full">
                <Undo2 size={20} /> Process Refund
              </Button>
            </div>
          )}
        </div>

        <ConfirmDialog
          open={confirmRefund}
          title="Confirm Refund"
          message={`Process refund of ${formatEgp(refundTotal)} for ${selectedRefundItems.length} item(s)? Inventory will be restored and this cannot be undone.`}
          confirmLabel="Yes, Process Refund"
          onConfirm={handleProcessRefund}
          onCancel={() => setConfirmRefund(false)}
        />
      </div>
    );
  }

  if (view === 'history') {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Refund History</h1>
            <p className="text-sm text-slate-500 mt-0.5">All processed refunds</p>
          </div>
          <Button variant="outline" onClick={() => setView('list')}>Back to Sales List</Button>
        </div>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Refund #</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Invoice</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Cashier</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Amount</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {refunds.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-12 text-slate-400">No refunds processed yet</td></tr>
                ) : (
                  refunds.map((r) => (
                    <tr key={r.id} className="table-row-hover">
                      <td className="px-4 py-3 text-sm font-medium text-slate-900">{r.refund_number}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{(r as Refund & { invoice_number?: string }).invoice_number}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{new Date(r.created_at).toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{(r as Refund & { cashier_name?: string }).cashier_name}</td>
                      <td className="px-4 py-3 text-right text-sm font-bold text-red-600">{formatEgp(r.total)}</td>
                      <td className="px-4 py-3 text-sm text-slate-500">{r.reason || '—'}</td>
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Refunds / Returns</h1>
          <p className="text-sm text-slate-500 mt-0.5">Find a sale and process full or partial refunds</p>
        </div>
        <Button variant="outline" onClick={() => setView('history')}>View Refund History</Button>
      </div>

      <div className="card p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            placeholder="Search by invoice number or customer name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-slate-300 pl-10 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Invoice</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Date</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Customer</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Cashier</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Total</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sales.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-12 text-slate-400">No sales found</td></tr>
              ) : (
                sales.map((s) => (
                  <tr key={s.id} className="table-row-hover">
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{s.invoice_number}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{new Date(s.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{s.customer_name || 'Walk-in'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{s.cashier_name}</td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-slate-900">{formatEgp(s.total)}</td>
                    <td className="px-4 py-3 text-center">
                      <Button size="sm" variant="outline" onClick={() => openSale(s)}>
                        <Receipt size={16} /> View & Refund
                      </Button>
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
