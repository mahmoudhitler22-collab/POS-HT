import { useState, useEffect, useCallback } from 'react';
import { query, execute } from '@/db/client';
import { useAuth } from '@/context/AuthContext';
import { logAudit } from '@/lib/audit';
import { formatEgp, toPiasters } from '@/lib/money';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import type { Expense } from '@/types';
import {
  Plus, Wallet, Trash2, Calendar, TrendingDown
} from 'lucide-react';

const EXPENSE_CATEGORIES = [
  'Rent', 'Electricity', 'Water', 'Salaries', 'Transportation',
  'Shipping', 'Maintenance', 'Supplies', 'Other'
];

export function ExpensesPage() {
  const { user } = useAuth();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);
  const [filterCategory, setFilterCategory] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const load = useCallback(async () => {
    let sql = `
      SELECT e.*, u.display_name as user_name
      FROM expenses e
      JOIN public_users u ON e.user_id = u.id
      WHERE 1=1
    `;
    const params: unknown[] = [];
    let idx = 1;
    if (filterCategory) {
      sql += ` AND e.category = $${idx++}`;
      params.push(filterCategory);
    }
    if (dateFrom) {
      sql += ` AND e.created_at >= $${idx++}`;
      params.push(dateFrom);
    }
    if (dateTo) {
      sql += ` AND e.created_at <= $${idx++} || ' 23:59:59'`;
      params.push(dateTo);
    }
    sql += ` ORDER BY e.created_at DESC`;
    const res = await query<Expense>(sql, params);
    setExpenses(res.rows);
  }, [filterCategory, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const totalAmount = expenses.reduce((sum, e) => sum + e.amount, 0);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await execute('DELETE FROM expenses WHERE id = $1', [deleteTarget.id]);
    await logAudit({ user_id: user?.id ?? null, action: 'expense_delete', entity_type: 'expense', entity_id: deleteTarget.id });
    toast('success', 'Expense deleted');
    setDeleteTarget(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Expenses</h1>
          <p className="text-sm text-slate-500 mt-0.5">Record and track business expenses</p>
        </div>
        <Button onClick={() => setShowModal(true)}>
          <Plus size={18} /> Add Expense
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
              <Wallet size={20} className="text-red-600" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Total Expenses</p>
              <p className="text-xl font-bold text-slate-900">{formatEgp(totalAmount)}</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center">
              <TrendingDown size={20} className="text-slate-600" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Number of Entries</p>
              <p className="text-xl font-bold text-slate-900">{expenses.length}</p>
            </div>
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <Calendar size={20} className="text-blue-600" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Categories Used</p>
              <p className="text-xl font-bold text-slate-900">{new Set(expenses.map((e) => e.category)).size}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="card p-4 flex gap-3 flex-wrap">
        <Select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="w-auto min-w-[160px]">
          <option value="">All Categories</option>
          {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" />
        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" />
        {(filterCategory || dateFrom || dateTo) && (
          <Button variant="ghost" size="sm" onClick={() => { setFilterCategory(''); setDateFrom(''); setDateTo(''); }}>Clear</Button>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Date</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Category</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Description</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Amount</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Recorded By</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {expenses.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-12 text-slate-400">
                  <Wallet size={40} className="mx-auto mb-2 opacity-40" />
                  No expenses recorded
                </td></tr>
              ) : (
                expenses.map((e) => (
                  <tr key={e.id} className="table-row-hover">
                    <td className="px-4 py-3 text-sm text-slate-600">{new Date(e.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{e.category}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{e.description || '—'}</td>
                    <td className="px-4 py-3 text-right text-sm font-bold text-red-600">{formatEgp(e.amount)}</td>
                    <td className="px-4 py-3 text-sm text-slate-500">{e.user_name}</td>
                    <td className="px-4 py-3 text-center">
                      <button onClick={() => setDeleteTarget(e)} className="p-1.5 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600">
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <ExpenseFormModal
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); load(); }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Expense"
        message={`Delete this expense of ${formatEgp(deleteTarget?.amount || 0)} for ${deleteTarget?.category}?`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function ExpenseFormModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { user } = useAuth();
  const [form, setForm] = useState({
    category: 'Rent',
    amount: '',
    description: '',
    date: new Date().toISOString().slice(0, 10),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    const amount = toPiasters(form.amount);
    if (amount <= 0) { setError('Amount must be greater than zero'); setSaving(false); return; }
    await execute(
      'INSERT INTO expenses (category, amount, description, user_id, created_at) VALUES ($1, $2, $3, $4, $5)',
      [form.category, amount, form.description || null, user!.id, form.date]
    );
    await logAudit({ user_id: user?.id ?? null, action: 'expense_create', entity_type: 'expense', new_value: JSON.stringify(form) });
    toast('success', 'Expense recorded');
    setSaving(false);
    onSaved();
  };

  return (
    <Modal open onClose={onClose} title="Add Expense" size="md" footer={
      <>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={saving}>{saving ? 'Saving...' : 'Save Expense'}</Button>
      </>
    }>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}
        <div className="grid grid-cols-2 gap-4">
          <Select label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Input label="Amount (EGP)" type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required autoFocus />
        </div>
        <Input label="Date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        <Textarea label="Description" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optional notes about this expense" />
      </form>
    </Modal>
  );
}
