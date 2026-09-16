import { useState, useEffect, useCallback } from 'react';
import { query } from '@/db/client';
import { formatEgp, formatQuantity } from '@/lib/money';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import {
  BarChart3, Download, TrendingUp, Wallet, Package, Undo2, Boxes, FileSpreadsheet, FileType
} from 'lucide-react';
import { exportExcel, exportPDF } from '@/lib/export';

type ReportType = 'sales' | 'profit' | 'inventory' | 'expenses' | 'refunds' | 'bestSelling' | 'stockMovement';

export function ReportsPage() {
  const [reportType, setReportType] = useState<ReportType>('sales');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [data, setData] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);

  const loadReport = useCallback(async () => {
    setLoading(true);
    const from = dateFrom || '2000-01-01';
    const to = (dateTo || new Date().toISOString().slice(0, 10)) + ' 23:59:59';

    let sql = '';
    switch (reportType) {
      case 'sales':
        sql = `SELECT s.invoice_number, s.created_at, u.display_name as cashier, c.name as customer,
                (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) as item_count,
                s.subtotal, s.discount_amount, s.total,
                COALESCE((SELECT SUM(r.total) FROM refunds r WHERE r.sale_id = s.id), 0) as refunded_amount,
                s.total - COALESCE((SELECT SUM(r.total) FROM refunds r WHERE r.sale_id = s.id), 0) as net_total,
                s.payment_method
              FROM sales s
              JOIN public_users u ON s.cashier_id = u.id
              LEFT JOIN customers c ON s.customer_id = c.id
              WHERE s.status = 'completed' AND s.created_at >= $1 AND s.created_at <= $2
              ORDER BY s.created_at DESC`;
        break;
      case 'profit':
        sql = `SELECT s.invoice_number, s.created_at,
                SUM(si.line_total) as revenue,
                SUM(si.discount_amount) as discounts,
                SUM(si.cost_at_sale * si.quantity) as cost_of_goods,
                COALESCE((SELECT SUM(r.total) FROM refunds r WHERE r.sale_id = s.id), 0) as refunded_amount,
                COALESCE((SELECT SUM(original_item.cost_at_sale * ri.quantity)
                  FROM refund_items ri
                  JOIN sale_items original_item ON original_item.id = ri.sale_item_id
                  JOIN refunds r ON r.id = ri.refund_id
                  WHERE r.sale_id = s.id), 0) as returned_cost,
                SUM(si.line_total) - COALESCE((SELECT SUM(r.total) FROM refunds r WHERE r.sale_id = s.id), 0) as net_revenue,
                SUM(si.cost_at_sale * si.quantity) - COALESCE((SELECT SUM(original_item.cost_at_sale * ri.quantity)
                  FROM refund_items ri
                  JOIN sale_items original_item ON original_item.id = ri.sale_item_id
                  JOIN refunds r ON r.id = ri.refund_id
                  WHERE r.sale_id = s.id), 0) as net_cost_of_goods,
                (SUM(si.line_total) - COALESCE((SELECT SUM(r.total) FROM refunds r WHERE r.sale_id = s.id), 0))
                  - (SUM(si.cost_at_sale * si.quantity) - COALESCE((SELECT SUM(original_item.cost_at_sale * ri.quantity)
                  FROM refund_items ri
                  JOIN sale_items original_item ON original_item.id = ri.sale_item_id
                  JOIN refunds r ON r.id = ri.refund_id
                  WHERE r.sale_id = s.id), 0)) as gross_profit
              FROM sales s
              JOIN sale_items si ON si.sale_id = s.id
              WHERE s.status = 'completed' AND s.created_at >= $1 AND s.created_at <= $2
              GROUP BY s.id ORDER BY s.created_at DESC`;
        break;
      case 'inventory':
        sql = `SELECT p.name, p.sku, p.barcode, p.quantity, p.purchase_cost, p.selling_price,
                (p.purchase_cost * p.quantity) as inventory_value
              FROM products p WHERE p.is_active = 1 ORDER BY p.name`;
        break;
      case 'expenses':
        sql = `SELECT e.created_at, e.category, e.amount, e.description, u.display_name as user_name
              FROM expenses e
              JOIN public_users u ON e.user_id = u.id
              WHERE e.created_at >= $1 AND e.created_at <= $2
              ORDER BY e.created_at DESC`;
        break;
      case 'refunds':
        sql = `SELECT r.refund_number, r.created_at, s.invoice_number, r.total, r.reason, u.display_name as cashier
              FROM refunds r
              JOIN sales s ON r.sale_id = s.id
              JOIN public_users u ON r.cashier_id = u.id
              WHERE r.created_at >= $1 AND r.created_at <= $2
              ORDER BY r.created_at DESC`;
        break;
      case 'bestSelling':
        sql = `SELECT si.product_name, SUM(si.quantity) as total_qty, SUM(si.line_total) as total_revenue,
                COUNT(DISTINCT s.id) as sale_count
              FROM sale_items si
              JOIN sales s ON si.sale_id = s.id
              WHERE s.status = 'completed' AND s.created_at >= $1 AND s.created_at <= $2
              GROUP BY si.product_name
              ORDER BY total_qty DESC LIMIT 50`;
        break;
      case 'stockMovement':
        sql = `SELECT m.created_at, p.name as product_name, m.quantity_change, m.previous_quantity,
                m.new_quantity, m.reason, u.display_name as user_name
              FROM inventory_movements m
              JOIN products p ON m.product_id = p.id
              JOIN public_users u ON m.user_id = u.id
              WHERE m.created_at >= $1 AND m.created_at <= $2
              ORDER BY m.created_at DESC LIMIT 500`;
        break;
    }

    try {
      const res = await query(sql, [from, to]);
      setData(res.rows);
    } catch (err) {
      console.error('Report error:', err);
      setData([]);
    }
    setLoading(false);
  }, [reportType, dateFrom, dateTo]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const exportCSV = () => {
    if (data.length === 0) return;
    const headers = Object.keys(data[0] as Record<string, unknown>);
    const csv = [
      headers.join(','),
      ...data.map((row) =>
        headers.map((h) => {
          const val = (row as Record<string, unknown>)[h];
          if (val === null || val === undefined) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
        }).join(',')
      )
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${reportType}_report_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getColumns = (): { header: string; key: string; isMoney?: boolean; isQty?: boolean }[] => {
    switch (reportType) {
      case 'sales': return [
        { header: 'Invoice', key: 'invoice_number' },
        { header: 'Date', key: 'created_at' },
        { header: 'Cashier', key: 'cashier' },
        { header: 'Customer', key: 'customer' },
        { header: 'Items', key: 'item_count', isQty: true },
        { header: 'Subtotal', key: 'subtotal', isMoney: true },
        { header: 'Discount', key: 'discount_amount', isMoney: true },
        { header: 'Original Total', key: 'total', isMoney: true },
        { header: 'Refunded', key: 'refunded_amount', isMoney: true },
        { header: 'Net Total', key: 'net_total', isMoney: true },
        { header: 'Payment', key: 'payment_method' },
      ];
      case 'profit': return [
        { header: 'Invoice', key: 'invoice_number' },
        { header: 'Date', key: 'created_at' },
        { header: 'Revenue', key: 'revenue', isMoney: true },
        { header: 'Discounts', key: 'discounts', isMoney: true },
        { header: 'COGS', key: 'cost_of_goods', isMoney: true },
        { header: 'Refunded', key: 'refunded_amount', isMoney: true },
        { header: 'Returned Cost', key: 'returned_cost', isMoney: true },
        { header: 'Net Revenue', key: 'net_revenue', isMoney: true },
        { header: 'Net COGS', key: 'net_cost_of_goods', isMoney: true },
        { header: 'Gross Profit', key: 'gross_profit', isMoney: true },
      ];
      case 'inventory': return [
        { header: 'Name', key: 'name' },
        { header: 'SKU', key: 'sku' },
        { header: 'Barcode', key: 'barcode' },
        { header: 'Quantity', key: 'quantity', isQty: true },
        { header: 'Cost', key: 'purchase_cost', isMoney: true },
        { header: 'Price', key: 'selling_price', isMoney: true },
        { header: 'Inventory Value', key: 'inventory_value', isMoney: true },
      ];
      case 'expenses': return [
        { header: 'Date', key: 'created_at' },
        { header: 'Category', key: 'category' },
        { header: 'Amount', key: 'amount', isMoney: true },
        { header: 'Description', key: 'description' },
        { header: 'User', key: 'user_name' },
      ];
      case 'refunds': return [
        { header: 'Refund #', key: 'refund_number' },
        { header: 'Date', key: 'created_at' },
        { header: 'Invoice', key: 'invoice_number' },
        { header: 'Total', key: 'total', isMoney: true },
        { header: 'Reason', key: 'reason' },
        { header: 'Cashier', key: 'cashier' },
      ];
      case 'bestSelling': return [
        { header: 'Product', key: 'product_name' },
        { header: 'Qty Sold', key: 'total_qty', isQty: true },
        { header: 'Revenue', key: 'total_revenue', isMoney: true },
        { header: 'Sale Count', key: 'sale_count', isQty: true },
      ];
      case 'stockMovement': return [
        { header: 'Date', key: 'created_at' },
        { header: 'Product', key: 'product_name' },
        { header: 'Change', key: 'quantity_change', isQty: true },
        { header: 'Previous', key: 'previous_quantity', isQty: true },
        { header: 'New', key: 'new_quantity', isQty: true },
        { header: 'Reason', key: 'reason' },
        { header: 'User', key: 'user_name' },
      ];
      default: return [];
    }
  };

  const exportToExcel = () => {
    if (data.length === 0) return;
    const cols = getColumns();
    exportExcel(`${reportType}_report`, reportType, cols, data as Record<string, unknown>[]);
  };

  const exportToPDF = () => {
    if (data.length === 0) return;
    const cols = getColumns();
    const labels: Record<string, string> = {
      sales: 'Sales Report', profit: 'Profit Report', inventory: 'Inventory Report',
      expenses: 'Expenses Report', refunds: 'Refund Report', bestSelling: 'Best-Selling Products',
      stockMovement: 'Stock Movement Report',
    };
    exportPDF(labels[reportType] || 'Report', cols, data as Record<string, unknown>[]);
  };

  const reportTypes: { key: ReportType; label: string; icon: React.ReactNode }[] = [
    { key: 'sales', label: 'Sales Report', icon: <TrendingUp size={18} /> },
    { key: 'profit', label: 'Profit Report', icon: <Wallet size={18} /> },
    { key: 'inventory', label: 'Inventory Report', icon: <Boxes size={18} /> },
    { key: 'expenses', label: 'Expenses Report', icon: <Wallet size={18} /> },
    { key: 'refunds', label: 'Refund Report', icon: <Undo2 size={18} /> },
    { key: 'bestSelling', label: 'Best-Selling Products', icon: <BarChart3 size={18} /> },
    { key: 'stockMovement', label: 'Stock Movement', icon: <Package size={18} /> },
  ];

  const renderTable = () => {
    if (data.length === 0) {
      return <tr><td colSpan={99} className="text-center py-12 text-slate-400">No data for this report</td></tr>;
    }
    const headers = Object.keys(data[0] as Record<string, unknown>);
    return (
      <>
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            {headers.map((h) => (
              <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                {h.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((row, i) => (
            <tr key={i} className="table-row-hover">
              {headers.map((h) => {
                const val = (row as Record<string, unknown>)[h];
                const isMoney = ['subtotal', 'discount_amount', 'total', 'revenue', 'discounts', 'cost_of_goods', 'gross_profit', 'amount', 'purchase_cost', 'selling_price', 'inventory_value', 'total_revenue'].includes(h);
                const isQty = ['quantity', 'total_qty', 'quantity_change', 'previous_quantity', 'new_quantity', 'item_count', 'sale_count'].includes(h);
                return (
                  <td key={h} className={`px-4 py-3 text-sm ${isMoney ? 'text-right font-medium' : 'text-slate-600'}`}>
                    {isMoney ? formatEgp(Number(val) || 0) :
                     isQty ? formatQuantity(Number(val) || 0) :
                     val === null ? '—' : String(val)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </>
    );
  };

  const needsDateFilter = reportType !== 'inventory';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Reports</h1>
          <p className="text-sm text-slate-500 mt-0.5">Generate and export business reports</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={exportCSV} disabled={data.length === 0}>
            <Download size={18} /> CSV
          </Button>
          <Button variant="outline" onClick={exportToExcel} disabled={data.length === 0}>
            <FileSpreadsheet size={18} /> Excel
          </Button>
          <Button variant="outline" onClick={exportToPDF} disabled={data.length === 0}>
            <FileType size={18} /> PDF
          </Button>
        </div>
      </div>

      <div className="flex gap-1 flex-wrap border-b border-slate-200">
        {reportTypes.map((rt) => (
          <button
            key={rt.key}
            onClick={() => setReportType(rt.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              reportType === rt.key ? 'border-teal-500 text-teal-600' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {rt.icon}
            {rt.label}
          </button>
        ))}
      </div>

      {needsDateFilter && (
        <div className="card p-4 flex gap-3 flex-wrap items-end">
          <Input label="From Date" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" />
          <Input label="To Date" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" />
          <Button onClick={loadReport} disabled={loading}>{loading ? 'Loading...' : 'Generate Report'}</Button>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full">
            {renderTable()}
          </table>
        </div>
      </div>
    </div>
  );
}
