import { useState, useEffect, useCallback } from 'react';
import { query } from '@/db/client';
import { useAuth } from '@/context/AuthContext';
import { formatEgp, formatQuantity } from '@/lib/money';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  TrendingUp, TrendingDown, DollarSign, ShoppingCart, Receipt,
  Wallet, AlertTriangle, Package, Award, Clock
} from 'lucide-react';

type Period = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth' | 'year' | 'all';

export function DashboardPage() {
  const { hasPermission } = useAuth();
  const [period, setPeriod] = useState<Period>('today');
  const [stats, setStats] = useState({
    totalSales: 0,
    invoiceCount: 0,
    totalDiscounts: 0,
    costOfGoods: 0,
    grossProfit: 0,
    totalExpenses: 0,
    netProfit: 0,
    refundTotal: 0,
  });
  const [inventoryValue, setInventoryValue] = useState(0);
  const [lowStock, setLowStock] = useState<{ name: string; quantity: number; min_stock_level: number }[]>([]);
  const [outStock, setOutStock] = useState<{ name: string }[]>([]);
  const [bestSelling, setBestSelling] = useState<{ product_name: string; total_qty: number; total_revenue: number }[]>([]);
  const [slowMoving, setSlowMoving] = useState<{ name: string; quantity: number }[]>([]);
  const [salesByMethod, setSalesByMethod] = useState<{ method: string; total: number; count: number }[]>([]);

  // Returns UTC timestamp strings for the start (inclusive) and end
  // (exclusive) of the selected local date range. SQLite stores
  // created_at as UTC via datetime('now'), so we convert local calendar
  // boundaries to UTC for correct filtering.
  const getDateRange = (p: Period): { from: string; to: string } => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let to = new Date(today);
    to.setDate(to.getDate() + 1);
    let from = new Date(today);

    switch (p) {
      case 'today': break;
      case 'yesterday':
        from.setDate(from.getDate() - 1);
        to.setDate(to.getDate() - 1);
        break;
      case 'week':
        from.setDate(from.getDate() - 6);
        break;
      case 'month':
        from = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'lastMonth':
        from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        to = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'year':
        from = new Date(now.getFullYear(), 0, 1);
        break;
      case 'all':
        from = new Date(2000, 0, 1);
        break;
    }
    // toISOString() converts local midnight to UTC. Since `from` and `to`
    // are local-midnight Date objects, their ISO strings are the correct
    // UTC boundaries. The half-open interval [from, to) is used directly
    // in queries with >= and <.
    return { from: from.toISOString().replace('T', ' ').slice(0, 19), to: to.toISOString().replace('T', ' ').slice(0, 19) };
  };

  const load = useCallback(async () => {
    const { from, to } = getDateRange(period);

    // Keep sales and refunds separate until after aggregation. Joining sale
    // items here would multiply an invoice total once for every item.
    const salesRes = await query<{
      total_sales: string; invoice_count: string; total_discounts: string;
    }>(
      `SELECT
        COALESCE(SUM(s.total), 0) as total_sales,
        COUNT(s.id) as invoice_count,
        COALESCE(SUM(s.discount_amount), 0) as total_discounts
      FROM sales s
      WHERE s.status = 'completed' AND s.created_at >= $1 AND s.created_at < $2`,
      [from, to]
    );

    const salesCogsRes = await query<{ total: string }>(
      `SELECT COALESCE(SUM(si.cost_at_sale * si.quantity), 0) as total
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.status = 'completed' AND s.created_at >= $1 AND s.created_at < $2`,
      [from, to]
    );
    const refundTotalRes = await query<{ total: string }>(
      'SELECT COALESCE(SUM(total), 0) as total FROM refunds WHERE created_at >= $1 AND created_at < $2',
      [from, to]
    );
    const returnedCogsRes = await query<{ total: string }>(
      `SELECT COALESCE(SUM(si.cost_at_sale * ri.quantity), 0) as total
       FROM refund_items ri
       JOIN refunds r ON r.id = ri.refund_id
       JOIN sale_items si ON si.id = ri.sale_item_id
       WHERE r.created_at >= $1 AND r.created_at < $2`,
      [from, to]
    );

    const row = salesRes.rows[0];
    const refundTotal = parseInt(refundTotalRes.rows[0].total, 10);
    // Revenue and COGS are both reduced by returned items.  This makes gross
    // profit reflect what remains sold, rather than treating a refund as an
    // extra expense on top of the original cost.
    const totalSales = parseInt(row.total_sales, 10) - refundTotal;
    const totalDiscounts = parseInt(row.total_discounts, 10);
    const costOfGoods = parseInt(salesCogsRes.rows[0].total, 10) - parseInt(returnedCogsRes.rows[0].total, 10);
    const grossProfit = totalSales - costOfGoods;

    // Expenses
    const expRes = await query<{ total: string }>(
      'SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE created_at >= $1 AND created_at < $2',
      [from, to]
    );
    const totalExpenses = parseInt(expRes.rows[0].total, 10);

    const netProfit = grossProfit - totalExpenses;

    setStats({
      totalSales,
      invoiceCount: parseInt(row.invoice_count, 10),
      totalDiscounts,
      costOfGoods,
      grossProfit,
      totalExpenses,
      netProfit,
      refundTotal,
    });

    // Inventory value
    const invRes = await query<{ value: string }>(
      'SELECT COALESCE(SUM(purchase_cost * quantity), 0) as value FROM products WHERE is_active = 1'
    );
    setInventoryValue(parseInt(invRes.rows[0].value, 10));

    // Low stock
    const lowRes = await query<{ name: string; quantity: number; min_stock_level: number }>(
      'SELECT name, quantity, min_stock_level FROM products WHERE is_active = 1 AND quantity > 0 AND quantity <= min_stock_level ORDER BY quantity ASC LIMIT 10'
    );
    setLowStock(lowRes.rows);

    // Out of stock
    const outRes = await query<{ name: string }>(
      'SELECT name FROM products WHERE is_active = 1 AND quantity <= 0 ORDER BY name LIMIT 10'
    );
    setOutStock(outRes.rows);

    // Best selling
    const bestRes = await query<{ product_name: string; total_qty: string; total_revenue: string }>(
      `SELECT si.product_name, SUM(si.quantity) as total_qty, SUM(si.line_total) as total_revenue
       FROM sale_items si
       JOIN sales s ON si.sale_id = s.id
       WHERE s.status = 'completed' AND s.created_at >= $1 AND s.created_at < $2
       GROUP BY si.product_name
       ORDER BY total_qty DESC LIMIT 5`,
      [from, to]
    );
    setBestSelling(bestRes.rows.map((r) => ({
      product_name: r.product_name,
      total_qty: parseFloat(r.total_qty),
      total_revenue: parseInt(r.total_revenue, 10),
    })));

    // Slow moving (products with no sales in the period)
    const slowRes = await query<{ name: string; quantity: number }>(
      `SELECT p.name, p.quantity FROM products p
       WHERE p.is_active = 1 AND p.id NOT IN (
         SELECT DISTINCT si.product_id FROM sale_items si
         JOIN sales s ON si.sale_id = s.id
         WHERE s.created_at >= $1 AND s.created_at < $2
       ) AND p.quantity > 0
       ORDER BY p.quantity DESC LIMIT 5`,
      [from, to]
    );
    setSlowMoving(slowRes.rows);

    // Sales by payment method
    const methodRes = await query<{ method: string; total: string; count: string }>(
      `SELECT payment_method as method, SUM(total) as total, COUNT(*) as count
       FROM sales
       WHERE status = 'completed' AND created_at >= $1 AND created_at < $2
       GROUP BY payment_method ORDER BY total DESC`,
      [from, to]
    );
    setSalesByMethod(methodRes.rows.map((r) => ({
      method: r.method,
      total: parseInt(r.total, 10),
      count: parseInt(r.count, 10),
    })));
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const periods: { key: Period; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'week', label: 'This Week' },
    { key: 'month', label: 'This Month' },
    { key: 'lastMonth', label: 'Last Month' },
    { key: 'year', label: 'This Year' },
    { key: 'all', label: 'All Time' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">Business overview and performance metrics</p>
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
          {periods.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                period === p.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Sales"
          value={formatEgp(stats.totalSales)}
          icon={<DollarSign size={20} />}
          color="blue"
          subtitle={`${stats.invoiceCount} invoices`}
        />
        <StatCard
          label="Gross Profit"
          value={formatEgp(stats.grossProfit)}
          icon={<TrendingUp size={20} />}
          color="emerald"
          subtitle={`Net revenue: ${formatEgp(stats.totalSales)}`}
        />
        <StatCard
          label="Total Expenses"
          value={formatEgp(stats.totalExpenses)}
          icon={<Wallet size={20} />}
          color="red"
          subtitle={`COGS: ${formatEgp(stats.costOfGoods)}`}
        />
        <StatCard
          label="Net Profit"
          value={formatEgp(stats.netProfit)}
          icon={stats.netProfit >= 0 ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
          color={stats.netProfit >= 0 ? 'emerald' : 'red'}
          subtitle={`Refunds: ${formatEgp(stats.refundTotal)}`}
        />
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MiniStat label="Invoices" value={String(stats.invoiceCount)} icon={<Receipt size={18} />} />
        <MiniStat label="Discounts Given" value={formatEgp(stats.totalDiscounts)} icon={<TrendingDown size={18} />} />
        <MiniStat label="Inventory Value" value={formatEgp(inventoryValue)} icon={<Package size={18} />} />
        <MiniStat label="Refunds" value={formatEgp(stats.refundTotal)} icon={<Receipt size={18} />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Best Selling */}
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Award size={18} className="text-amber-500" />
            <h3 className="font-semibold text-slate-900">Best Selling Products</h3>
          </div>
          {bestSelling.length === 0 ? (
            <p className="text-sm text-slate-400 py-8 text-center">No sales in this period</p>
          ) : (
            <div className="space-y-3">
              {bestSelling.map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">{item.product_name}</p>
                    <p className="text-xs text-slate-400">{formatQuantity(item.total_qty)} sold</p>
                  </div>
                  <p className="text-sm font-semibold text-slate-900">{formatEgp(item.total_revenue)}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sales by Payment Method */}
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <DollarSign size={18} className="text-blue-500" />
            <h3 className="font-semibold text-slate-900">Sales by Payment Method</h3>
          </div>
          {salesByMethod.length === 0 ? (
            <p className="text-sm text-slate-400 py-8 text-center">No sales in this period</p>
          ) : (
            <div className="space-y-3">
              {salesByMethod.map((m) => {
                const maxTotal = Math.max(...salesByMethod.map((x) => x.total), 1);
                const pct = (m.total / maxTotal) * 100;
                return (
                  <div key={m.method}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="font-medium text-slate-700">{m.method}</span>
                      <span className="text-slate-900 font-semibold">{formatEgp(m.total)}</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-teal-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">{m.count} transactions</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Low Stock Alerts */}
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle size={18} className="text-amber-500" />
            <h3 className="font-semibold text-slate-900">Low Stock Alerts</h3>
          </div>
          {lowStock.length === 0 ? (
            <p className="text-sm text-slate-400 py-8 text-center">All products are well stocked</p>
          ) : (
            <div className="space-y-2">
              {lowStock.map((p, i) => (
                <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-amber-50">
                  <span className="text-sm font-medium text-slate-700">{p.name}</span>
                  <Badge variant="warning">{formatQuantity(p.quantity)} / min {formatQuantity(p.min_stock_level)}</Badge>
                </div>
              ))}
            </div>
          )}
          {outStock.length > 0 && (
            <div className="mt-4 pt-4 border-t border-slate-200">
              <p className="text-xs font-medium text-red-600 mb-2">Out of Stock ({outStock.length})</p>
              <div className="space-y-1">
                {outStock.slice(0, 5).map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-slate-600">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                    {p.name}
                  </div>
                ))}
                {outStock.length > 5 && <p className="text-xs text-slate-400">+ {outStock.length - 5} more</p>}
              </div>
            </div>
          )}
        </div>

        {/* Slow Moving */}
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Clock size={18} className="text-slate-400" />
            <h3 className="font-semibold text-slate-900">Slow Moving Products</h3>
          </div>
          {slowMoving.length === 0 ? (
            <p className="text-sm text-slate-400 py-8 text-center">No slow-moving products in this period</p>
          ) : (
            <div className="space-y-2">
              {slowMoving.map((p, i) => (
                <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-slate-50">
                  <span className="text-sm font-medium text-slate-700">{p.name}</span>
                  <span className="text-sm text-slate-500">Stock: {formatQuantity(p.quantity)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, color, subtitle }: {
  label: string; value: string; icon: React.ReactNode; color: 'blue' | 'emerald' | 'red'; subtitle: string;
}) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    red: 'bg-red-50 text-red-600',
  };
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colors[color]}`}>
          {icon}
        </div>
      </div>
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
      <p className="text-xs text-slate-400 mt-1">{subtitle}</p>
    </div>
  );
}

function MiniStat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600">
        {icon}
      </div>
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="text-lg font-bold text-slate-900">{value}</p>
      </div>
    </div>
  );
}
