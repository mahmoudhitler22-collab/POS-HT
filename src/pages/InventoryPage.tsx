import { useState, useEffect, useCallback } from 'react';
import { query, transaction } from '@/db/client';
import { useAuth } from '@/context/AuthContext';
import { logAudit } from '@/lib/audit';
import { formatEgp, formatQuantity, parseLocalizedNumber } from '@/lib/money';
import { arabicSearchPattern, matchesArabicSearch, normalizeArabicSql } from '@/lib/search';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import type { Product, InventoryMovement } from '@/types';
import {
  Boxes, Search, Plus, AlertTriangle, ClipboardCheck,
  History, TrendingUp, TrendingDown
} from 'lucide-react';

type Tab = 'overview' | 'movements' | 'stocktake' | 'adjust';
type InventoryProduct = Product & { variant_count: number; variant_total_stock: number };

const stockQuantity = (product: InventoryProduct): number =>
  Number(product.variant_count) > 0 ? Number(product.variant_total_stock) : product.quantity;

export function InventoryPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [showAdjustModal, setShowAdjustModal] = useState<Product | null>(null);
  const [showStocktakeModal, setShowStocktakeModal] = useState(false);

  const loadProducts = useCallback(async () => {
    let sql = `SELECT p.*, c.name as category_name,
                      COALESCE(v.variant_count, 0) AS variant_count,
                      COALESCE(v.variant_total_stock, 0) AS variant_total_stock
                 FROM products p
                 LEFT JOIN categories c ON p.category_id = c.id
                 LEFT JOIN (
                   SELECT product_id, COUNT(*) AS variant_count, SUM(quantity) AS variant_total_stock
                     FROM product_variants WHERE is_active = 1 GROUP BY product_id
                 ) v ON v.product_id = p.id
                WHERE p.is_active = 1`;
    const params: unknown[] = [];
    if (search.trim()) {
      sql += ` AND (${normalizeArabicSql('p.name')} LIKE $1 OR ${normalizeArabicSql('p.sku')} LIKE $1 OR ${normalizeArabicSql('p.barcode')} LIKE $1 OR ${normalizeArabicSql('p.color')} LIKE $1 OR ${normalizeArabicSql('p.size')} LIKE $1)`;
      params.push(arabicSearchPattern(search));
    }
    sql += ` ORDER BY p.name`;
    const res = await query<InventoryProduct>(sql, params);
    setProducts(res.rows.filter((product) => {
      const quantity = stockQuantity(product);
      return filter === 'all' || (filter === 'low' ? quantity > 0 && quantity <= product.min_stock_level : quantity <= 0);
    }));
  }, [search, filter]);

  const loadMovements = useCallback(async () => {
    const res = await query<InventoryMovement>(
      `SELECT m.*, p.name as product_name, u.display_name as user_name
       FROM inventory_movements m
       JOIN products p ON m.product_id = p.id
       JOIN public_users u ON m.user_id = u.id
       ORDER BY m.created_at DESC LIMIT 200`
    );
    setMovements(res.rows);
  }, []);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { if (tab === 'movements') loadMovements(); }, [tab, loadMovements]);

  const inventoryValue = products.reduce((sum, p) => sum + (p.purchase_cost ?? 0) * stockQuantity(p), 0);
  const lowStockCount = products.filter((p) => stockQuantity(p) > 0 && stockQuantity(p) <= p.min_stock_level).length;
  const outStockCount = products.filter((p) => stockQuantity(p) <= 0).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Inventory</h1>
        <p className="text-sm text-slate-500 mt-0.5">Track stock levels, movements, and perform stocktakes</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <Boxes size={20} className="text-blue-600" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Total Products</p>
              <p className="text-xl font-bold text-slate-900">{products.length}</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
              <TrendingUp size={20} className="text-emerald-600" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Inventory Value</p>
              <p className="text-xl font-bold text-slate-900">{formatEgp(inventoryValue)}</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
              <AlertTriangle size={20} className="text-amber-600" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Low Stock</p>
              <p className="text-xl font-bold text-slate-900">{lowStockCount}</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
              <TrendingDown size={20} className="text-red-600" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Out of Stock</p>
              <p className="text-xl font-bold text-slate-900">{outStockCount}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {([
          { key: 'overview', label: 'Stock Overview', icon: <Boxes size={16} /> },
          { key: 'movements', label: 'Movement History', icon: <History size={16} /> },
          { key: 'stocktake', label: 'Stocktake', icon: <ClipboardCheck size={16} /> },
          { key: 'adjust', label: 'Quick Adjust', icon: <Plus size={16} /> },
        ] as { key: Tab; label: string; icon: React.ReactNode }[]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key ? 'border-teal-500 text-teal-600' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="card p-4 flex gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                type="text"
                placeholder="Search products..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-slate-300 pl-10 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
            <Select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'low' | 'out')} className="w-auto">
              <option value="all">All Products</option>
              <option value="low">Low Stock</option>
              <option value="out">Out of Stock</option>
            </Select>
          </div>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Product</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Barcode</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Stock</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Min Level</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Status</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {products.length === 0 ? (
                    <tr><td colSpan={6} className="text-center py-12 text-slate-400">No products found</td></tr>
                  ) : (
                    products.map((p) => (
                      <tr key={p.id} className="table-row-hover">
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900">{p.name}</div>
                          {p.size && <span className="text-xs text-slate-400">{p.size} · {p.color}</span>}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600 font-mono">{p.barcode || '—'}</td>
                        <td className="px-4 py-3 text-right text-sm font-medium text-slate-900">{formatQuantity(stockQuantity(p))}</td>
                        <td className="px-4 py-3 text-right text-sm text-slate-500">{formatQuantity(p.min_stock_level)}</td>
                        <td className="px-4 py-3 text-center">
                          {stockQuantity(p) <= 0 ? <Badge variant="danger">Out of Stock</Badge> :
                           stockQuantity(p) <= p.min_stock_level ? <Badge variant="warning">Low Stock</Badge> :
                           <Badge variant="success">In Stock</Badge>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Button size="sm" variant="outline" onClick={() => {
                            if (Number(p.variant_count) > 0) {
                              toast('info', 'Adjust stock for each color and size from the product variants matrix');
                              return;
                            }
                            setShowAdjustModal(p);
                          }}>
                            {Number(p.variant_count) > 0 ? 'Manage Variants' : 'Adjust'}
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'movements' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Product</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Change</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Previous</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">New</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Reason</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">User</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {movements.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-12 text-slate-400">No movements recorded yet</td></tr>
                ) : (
                  movements.map((m) => (
                    <tr key={m.id} className="table-row-hover">
                      <td className="px-4 py-3 text-sm text-slate-600">{new Date(m.created_at).toLocaleString()}</td>
                      <td className="px-4 py-3 text-sm font-medium text-slate-900">{m.product_name}</td>
                      <td className={`px-4 py-3 text-right text-sm font-medium ${m.quantity_change > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {m.quantity_change > 0 ? '+' : ''}{formatQuantity(m.quantity_change)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-slate-500">{formatQuantity(m.previous_quantity)}</td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-slate-900">{formatQuantity(m.new_quantity)}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{m.reason}</td>
                      <td className="px-4 py-3 text-sm text-slate-500">{m.user_name}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'stocktake' && (
        <div className="card p-6">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-12 h-12 rounded-xl bg-teal-50 flex items-center justify-center flex-shrink-0">
              <ClipboardCheck size={24} className="text-teal-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Stocktake / Inventory Count</h3>
              <p className="text-sm text-slate-500 mt-1">Count your physical inventory and compare with system quantities. Any differences will be recorded with an audit trail.</p>
            </div>
          </div>
          <Button onClick={() => setShowStocktakeModal(true)}>
            Start New Stocktake
          </Button>
        </div>
      )}

      {tab === 'adjust' && (
        <div className="card p-6">
          <div className="flex items-start gap-4 mb-6">
            <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
              <Plus size={24} className="text-blue-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Quick Stock Adjustment</h3>
              <p className="text-sm text-slate-500 mt-1">Add or remove stock for a product. Every adjustment is recorded in the movement history with a reason.</p>
            </div>
          </div>
          <p className="text-sm text-slate-500">Use the Stock Overview tab and click "Adjust" on any product to add or remove stock.</p>
        </div>
      )}

      {showAdjustModal && (
        <AdjustStockModal
          product={showAdjustModal}
          onClose={() => setShowAdjustModal(null)}
          onSaved={() => { setShowAdjustModal(null); loadProducts(); }}
        />
      )}

      {showStocktakeModal && (
        <StocktakeModal
          onClose={() => setShowStocktakeModal(false)}
          onCompleted={() => { setShowStocktakeModal(false); loadProducts(); }}
        />
      )}
    </div>
  );
}

function AdjustStockModal({ product, onClose, onSaved }: { product: Product; onClose: () => void; onSaved: () => void }) {
  const { user } = useAuth();
  const [type, setType] = useState<'add' | 'remove' | 'set'>('add');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const qty = parseLocalizedNumber(quantity) || 0;
    if (qty <= 0) { toast('error', 'Quantity must be greater than zero'); return; }
    if (!reason.trim()) { toast('error', 'Please provide a reason'); return; }

    try {
      await transaction(async (tx) => {
        const prodRes = await tx.query<{ quantity: number }>('SELECT quantity FROM products WHERE id = $1', [product.id]);
        const prevQty = prodRes.rows[0].quantity;
        let newQty: number;
        let change: number;
        if (type === 'add') { change = qty; newQty = prevQty + qty; }
        else if (type === 'remove') { change = -qty; newQty = prevQty - qty; }
        else { change = qty - prevQty; newQty = qty; }

        await tx.exec('UPDATE products SET quantity = $1, updated_at = datetime(\'now\') WHERE id = $2', [newQty, product.id]);
        await tx.exec(
          `INSERT INTO inventory_movements (product_id, quantity_change, previous_quantity, new_quantity, reason, reference_type, reference_id, user_id)
           VALUES ($1, $2, $3, $4, $5, 'manual_adjust', NULL, $6)`,
          [product.id, change, prevQty, newQty, reason.trim(), user!.id]
        );
      });

      await logAudit({
        user_id: user?.id ?? null,
        action: 'stock_adjust',
        entity_type: 'product',
        entity_id: product.id,
        previous_value: String(product.quantity),
        new_value: String(type === 'set' ? quantity : type === 'add' ? product.quantity + qty : product.quantity - qty),
      });

      toast('success', 'Stock adjusted successfully');
      onSaved();
    } catch {
      toast('error', 'Failed to adjust stock');
    }
  };

  return (
    <Modal open onClose={onClose} title="Adjust Stock" size="md" footer={
      <>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit}>Save Adjustment</Button>
      </>
    }>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-slate-50 rounded-lg p-3">
          <p className="font-medium text-slate-900">{product.name}</p>
          <p className="text-sm text-slate-500">Current stock: {formatQuantity(product.quantity)}</p>
        </div>
        <Select label="Adjustment Type" value={type} onChange={(e) => setType(e.target.value as 'add' | 'remove' | 'set')}>
          <option value="add">Add Stock (receive inventory)</option>
          <option value="remove">Remove Stock (damaged, lost, etc.)</option>
          <option value="set">Set Exact Quantity (correction)</option>
        </Select>
        <Input label="Quantity" type="number" step="0.01" value={quantity} onChange={(e) => setQuantity(e.target.value)} required autoFocus />
        <Textarea label="Reason *" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Received from supplier, damaged goods, stock count correction" required />
      </form>
    </Modal>
  );
}

function StocktakeModal({ onClose, onCompleted }: { onClose: () => void; onCompleted: () => void }) {
  const { user } = useAuth();
  const [products, setProducts] = useState<{ product_id: number; variant_id: number | null; name: string; system_qty: number; counted_qty: string; size: string | null; color: string | null }[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    (async () => {
      const res = await query<{ product_id: number; variant_id: number | null; name: string; quantity: number; size: string | null; color: string | null }>(
        `SELECT p.id AS product_id, CAST(NULL AS INTEGER) AS variant_id, p.name, p.quantity, p.size, p.color
           FROM products p
          WHERE p.is_active = 1
            AND NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1)
         UNION ALL
         SELECT p.id AS product_id, pv.id AS variant_id, p.name, pv.quantity, pv.size, pv.color
           FROM product_variants pv JOIN products p ON p.id = pv.product_id
          WHERE p.is_active = 1 AND pv.is_active = 1
         ORDER BY name, color, size`
      );
      setProducts(res.rows.map((p) => ({ ...p, system_qty: p.quantity, counted_qty: '' })));
    })();
  }, []);

  const filtered = products.filter((p) => !search || matchesArabicSearch(p.name, search));
  const differences = products.filter((p) => p.counted_qty && parseLocalizedNumber(p.counted_qty) !== p.system_qty);

  const handleComplete = async () => {
    if (differences.length === 0) {
      toast('info', 'No differences found. Stock is accurate.');
      onClose();
      return;
    }

    try {
      await transaction(async (tx) => {
        for (const p of differences) {
          const counted = parseLocalizedNumber(p.counted_qty);
          const change = counted - p.system_qty;
          if (p.variant_id === null) {
            await tx.exec('UPDATE products SET quantity = $1, updated_at = datetime(\'now\') WHERE id = $2', [counted, p.product_id]);
          } else {
            await tx.exec('UPDATE product_variants SET quantity = $1, updated_at = datetime(\'now\') WHERE id = $2', [counted, p.variant_id]);
          }
          await tx.exec(
            `INSERT INTO inventory_movements (product_id, variant_id, quantity_change, previous_quantity, new_quantity, reason, reference_type, reference_id, user_id)
             VALUES ($1, $2, $3, $4, $5, 'Stocktake adjustment', 'stocktake', NULL, $6)`,
            [p.product_id, p.variant_id, change, p.system_qty, counted, user!.id]
          );
        }
      });

      await logAudit({
        user_id: user?.id ?? null,
        action: 'stocktake_complete',
        entity_type: 'inventory',
        new_value: JSON.stringify({ adjusted: differences.length }),
      });

      toast('success', `Stocktake complete. ${differences.length} products adjusted.`);
      onCompleted();
    } catch {
      toast('error', 'Failed to complete stocktake');
    }
  };

  return (
    <Modal open onClose={onClose} title="Stocktake / Inventory Count" size="xl" footer={
      <>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={handleComplete} disabled={differences.length === 0}>
          Apply {differences.length} Adjustment{differences.length !== 1 ? 's' : ''}
        </Button>
      </>
    }>
      <div className="space-y-4">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-700">
          Enter the physically counted quantity for each product. Products with a difference from the system quantity will be highlighted.
        </div>
        <Input placeholder="Search products..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="max-h-[400px] overflow-y-auto scrollbar-thin border border-slate-200 rounded-lg">
          <table className="w-full">
            <thead className="bg-slate-50 sticky top-0">
              <tr>
                <th className="text-left px-3 py-2 text-xs font-semibold text-slate-600 uppercase">Product</th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-slate-600 uppercase">System Qty</th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-slate-600 uppercase">Counted Qty</th>
                <th className="text-right px-3 py-2 text-xs font-semibold text-slate-600 uppercase">Diff</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((p) => {
                const counted = p.counted_qty ? parseLocalizedNumber(p.counted_qty) : null;
                const diff = counted !== null ? counted - p.system_qty : null;
                return (
                  <tr key={`${p.product_id}:${p.variant_id ?? 'product'}`} className={diff !== null && diff !== 0 ? 'bg-amber-50' : ''}>
                    <td className="px-3 py-2 text-sm text-slate-900">{p.name}
                      {p.size && <span className="text-xs text-slate-400 ml-2">{p.size} {p.color}</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-sm text-slate-600">{formatQuantity(p.system_qty)}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={p.counted_qty}
                        onChange={(e) => setProducts((prev) => prev.map((x) => x.product_id === p.product_id && x.variant_id === p.variant_id ? { ...x, counted_qty: e.target.value } : x))}
                        className="w-20 text-right text-sm border border-slate-200 rounded px-2 py-1"
                        placeholder="—"
                      />
                    </td>
                    <td className={`px-3 py-2 text-right text-sm font-medium ${diff === null ? 'text-slate-300' : diff > 0 ? 'text-emerald-600' : diff < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                      {diff === null ? '—' : (diff > 0 ? '+' : '') + formatQuantity(diff)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
