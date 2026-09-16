import { useCallback, useEffect, useState } from 'react';
import { query } from '@/db/client';
import { formatEgp, formatQuantity } from '@/lib/money';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { BarChart3, Clock3, RefreshCw, Trophy } from 'lucide-react';

type Period = 'today' | 'week' | 'month' | 'year' | 'custom';
interface EmployeeRow {
  employee_id: number;
  employee: string;
  working_hours: number;
  transactions: number;
  items_sold: number;
  sales_amount: number;
  discounts: number;
  cost_of_goods: number;
  gross_profit: number;
  profit_margin: number;
  sales_rank: number;
  profit_rank: number;
  hours_rank: number;
}
interface ProductRow { employee: string; product: string; quantity: number; revenue: number; }

function rangeFor(period: Period, from: string, to: string): [string, string] {
  if (period === 'custom') return [`${from || '2000-01-01'} 00:00:00`, `${to || new Date().toISOString().slice(0, 10)} 23:59:59`];
  const start = new Date();
  if (period === 'today') start.setHours(0, 0, 0, 0);
  if (period === 'week') { const day = start.getDay(); start.setDate(start.getDate() - (day === 0 ? 6 : day - 1)); start.setHours(0, 0, 0, 0); }
  if (period === 'month') { start.setDate(1); start.setHours(0, 0, 0, 0); }
  if (period === 'year') { start.setMonth(0, 1); start.setHours(0, 0, 0, 0); }
  return [start.toISOString().slice(0, 19).replace('T', ' '), `${new Date().toISOString().slice(0, 19).replace('T', ' ')}`];
}

export function EmployeePerformancePage() {
  const [period, setPeriod] = useState<Period>('today');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [start, end] = rangeFor(period, from, to);
    const stats = await query<EmployeeRow>(
      `SELECT u.id employee_id, u.display_name employee,
        ROUND(COALESCE(SUM((julianday(MIN(COALESCE(us.logout_at, datetime('now')), datetime(us.login_at, '+12 hours'))) - julianday(us.login_at)) * 24), 0), 2) working_hours,
        COUNT(DISTINCT s.id) transactions, COALESCE(SUM(si.quantity), 0) items_sold,
        COALESCE(SUM(si.line_total), 0) sales_amount, COALESCE(SUM(si.discount_amount), 0) discounts,
        COALESCE(SUM(si.cost_at_sale * si.quantity), 0) cost_of_goods,
        COALESCE(SUM(si.line_total - si.cost_at_sale * si.quantity), 0) gross_profit,
        CASE WHEN COALESCE(SUM(si.line_total), 0) = 0 THEN 0 ELSE ROUND(SUM(si.line_total - si.cost_at_sale * si.quantity) * 100.0 / SUM(si.line_total), 2) END profit_margin,
        RANK() OVER (ORDER BY COALESCE(SUM(si.line_total), 0) DESC) sales_rank,
        RANK() OVER (ORDER BY COALESCE(SUM(si.line_total - si.cost_at_sale * si.quantity), 0) DESC) profit_rank,
        RANK() OVER (ORDER BY COALESCE(SUM((julianday(MIN(COALESCE(us.logout_at, datetime('now')), datetime(us.login_at, '+12 hours'))) - julianday(us.login_at)) * 24), 0) DESC) hours_rank
       FROM users u LEFT JOIN user_sessions us ON us.user_id = u.id AND us.login_at >= $1 AND us.login_at <= $2
       LEFT JOIN sales s ON s.cashier_id = u.id AND s.status = 'completed' AND s.created_at >= $1 AND s.created_at <= $2
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE u.is_active = 1 GROUP BY u.id ORDER BY sales_amount DESC`, [start, end]
    );
    const productRes = await query<ProductRow>(
      `SELECT u.display_name employee, si.product_name product, SUM(si.quantity) quantity, SUM(si.line_total) revenue
       FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN users u ON u.id = s.cashier_id
       WHERE s.status = 'completed' AND s.created_at >= $1 AND s.created_at <= $2
       GROUP BY u.id, si.product_name ORDER BY u.display_name, revenue DESC`, [start, end]
    );
    setRows(stats.rows); setProducts(productRes.rows); setLoading(false);
  }, [period, from, to]);

  useEffect(() => { void load(); }, [load]);

  return <div className="space-y-6">
    <div className="flex items-center justify-between flex-wrap gap-4">
      <div><h1 className="text-2xl font-bold text-slate-900">Employee Performance</h1><p className="text-sm text-slate-500 mt-1">Working time and sales performance from SQLite records</p></div>
      <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /> Refresh</Button>
    </div>
    <div className="card p-4 flex flex-wrap items-end gap-2">
      {(['today', 'week', 'month', 'year', 'custom'] as Period[]).map((item) => <button key={item} onClick={() => setPeriod(item)} className={`px-3 py-2 rounded-lg text-sm font-medium ${period === item ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{item === 'today' ? 'Today' : item === 'week' ? 'This week' : item === 'month' ? 'This month' : item === 'year' ? 'This year' : 'Custom'}</button>)}
      {period === 'custom' && <><Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} /><Button onClick={() => void load()}>Apply</Button></>}
    </div>
    <div className="card overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50"><tr>{['Employee', 'Hours', 'Transactions', 'Items', 'Sales', 'Discounts', 'COGS', 'Gross Profit', 'Margin', 'Ranks'].map((h) => <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-slate-600">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{rows.map((row) => <tr key={row.employee_id}><td className="px-4 py-3 font-medium text-slate-900">{row.employee}</td><td className="px-4 py-3"><Clock3 size={14} className="inline mr-1" />{Number(row.working_hours).toFixed(2)}</td><td className="px-4 py-3">{row.transactions}</td><td className="px-4 py-3">{formatQuantity(Number(row.items_sold))}</td><td className="px-4 py-3 font-medium">{formatEgp(Number(row.sales_amount))}</td><td className="px-4 py-3 text-red-600">{formatEgp(Number(row.discounts))}</td><td className="px-4 py-3">{formatEgp(Number(row.cost_of_goods))}</td><td className="px-4 py-3 text-emerald-700 font-semibold">{formatEgp(Number(row.gross_profit))}</td><td className="px-4 py-3">{Number(row.profit_margin).toFixed(2)}%</td><td className="px-4 py-3 text-xs">Sales #{row.sales_rank} · Profit #{row.profit_rank} · Hours #{row.hours_rank}</td></tr>)}</tbody></table></div></div>
    <div className="card p-5"><h2 className="font-semibold text-slate-900 mb-4"><Trophy size={18} className="inline mr-2 text-amber-500" />Products sold by employee</h2><div className="grid md:grid-cols-2 gap-3">{products.map((item, index) => <div key={`${item.employee}-${item.product}-${index}`} className="flex justify-between border-b border-slate-100 py-2 text-sm"><span><b>{item.employee}</b> — {item.product}</span><span>{formatQuantity(Number(item.quantity))} · {formatEgp(Number(item.revenue))}</span></div>)}{products.length === 0 && <p className="text-sm text-slate-400">No sales in this period.</p>}</div></div>
  </div>;
}
