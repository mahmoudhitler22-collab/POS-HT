import { useState, useEffect, useCallback } from 'react';
import { query, execute } from '@/db/client';
import { useAuth } from '@/context/AuthContext';
import { logAudit } from '@/lib/audit';
import { formatEgp } from '@/lib/money';
import { arabicSearchPattern, normalizeArabicSql } from '@/lib/search';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { useSettings } from '@/context/SettingsContext';
import type { Customer } from '@/types';
import {
  Plus, Search, Pencil, Trash2, Users, Star
} from 'lucide-react';

export function CustomersPage() {
  const { user } = useAuth();
  const { get } = useSettings();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);

  const loyaltyEnabled = get('loyalty_enabled', '0') === '1';

  const load = useCallback(async () => {
    let sql = 'SELECT * FROM customers';
    const params: unknown[] = [];
    if (search.trim()) {
      sql += ` WHERE ${normalizeArabicSql('name')} LIKE $1 OR ${normalizeArabicSql('phone')} LIKE $1`;
      params.push(arabicSearchPattern(search));
    }
    sql += ' ORDER BY name';
    const res = await query<Customer>(sql, params);
    setCustomers(res.rows);
  }, [search]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await execute('DELETE FROM customers WHERE id = $1', [deleteTarget.id]);
    await logAudit({ user_id: user?.id ?? null, action: 'customer_delete', entity_type: 'customer', entity_id: deleteTarget.id });
    toast('success', 'Customer deleted');
    setDeleteTarget(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage customer information and loyalty points</p>
        </div>
        <Button onClick={() => { setEditing(null); setShowModal(true); }}>
          <Plus size={18} /> Add Customer
        </Button>
      </div>

      <div className="card p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            placeholder="Search by name or phone..."
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
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Phone</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Purchases</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Total Spent</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Last Purchase</th>
                {loyaltyEnabled && <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Points</th>}
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {customers.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12 text-slate-400">
                  <Users size={40} className="mx-auto mb-2 opacity-40" />
                  No customers yet
                </td></tr>
              ) : (
                customers.map((c) => (
                  <tr key={c.id} className="table-row-hover">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{c.name}</div>
                      {c.notes && <div className="text-xs text-slate-400 truncate max-w-[200px]">{c.notes}</div>}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{c.phone || '—'}</td>
                    <td className="px-4 py-3 text-right text-sm text-slate-600">{c.purchase_count}</td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-slate-900">{formatEgp(c.total_purchases)}</td>
                    <td className="px-4 py-3 text-right text-sm text-slate-500">
                      {c.last_purchase_date ? new Date(c.last_purchase_date).toLocaleDateString() : '—'}
                    </td>
                    {loyaltyEnabled && (
                      <td className="px-4 py-3 text-right">
                        <Badge variant="info"><Star size={12} className="mr-1" />{c.loyalty_points}</Badge>
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => { setEditing(c); setShowModal(true); }} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700">
                          <Pencil size={16} />
                        </button>
                        <button onClick={() => setDeleteTarget(c)} className="p-1.5 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <CustomerFormModal
          customer={editing}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { setShowModal(false); setEditing(null); load(); }}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Customer"
        message={`Delete "${deleteTarget?.name}"? Their purchase history in past sales will be preserved, but the customer record will be removed.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function CustomerFormModal({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved: () => void }) {
  const { user } = useAuth();
  const [form, setForm] = useState({
    name: customer?.name || '',
    phone: customer?.phone || '',
    notes: customer?.notes || '',
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    if (customer) {
      await execute('UPDATE customers SET name = $1, phone = $2, notes = $3 WHERE id = $4', [form.name.trim(), form.phone || null, form.notes || null, customer.id]);
      await logAudit({ user_id: user?.id ?? null, action: 'customer_update', entity_type: 'customer', entity_id: customer.id });
      toast('success', 'Customer updated');
    } else {
      const res = await query<{ id: number }>('INSERT INTO customers (name, phone, notes) VALUES ($1, $2, $3) RETURNING id', [form.name.trim(), form.phone || null, form.notes || null]);
      await logAudit({ user_id: user?.id ?? null, action: 'customer_create', entity_type: 'customer', entity_id: res.rows[0].id });
      toast('success', 'Customer added');
    }
    setSaving(false);
    onSaved();
  };

  return (
    <Modal open onClose={onClose} title={customer ? 'Edit Customer' : 'Add Customer'} size="md" footer={
      <>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
      </>
    }>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
        <Input label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone number" />
        <Textarea label="Notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </form>
    </Modal>
  );
}
