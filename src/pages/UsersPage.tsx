import { useState, useEffect, useCallback } from 'react';
import { query, execute, isRunningInElectron, getAuthSessionId, deleteUser } from '@/db/client';
import { useAuth } from '@/context/AuthContext';
import { logAudit } from '@/lib/audit';
import { hashPassword } from '@/lib/crypto';
import {
  ALL_PERMISSIONS, OWNER_PERMISSIONS, MANAGER_PERMISSIONS,
  CASHIER_PERMISSIONS, INVENTORY_PERMISSIONS,
  parsePermissions, type PermissionSet
} from '@/lib/permissions';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import type { User } from '@/types';
import {
  Plus, Pencil, Trash2, UserCog, Shield, Lock, Check
} from 'lucide-react';

// Hash a password using the main process (scrypt) when running in Electron,
// or the browser's Web Crypto API (PBKDF2) when running standalone.
// This ensures hashes are always verifiable by the Electron login flow.
async function hashPasswordForStorage(password: string): Promise<{ hash: string; salt: string }> {
  if (isRunningInElectron()) {
    const sid = getAuthSessionId();
    if (sid === undefined) throw new Error('Not authenticated');
    const res = await window.electronAPI.auth.hashPassword(sid, password);
    if (!res.success || !res.hash || !res.salt) {
      throw new Error(res.error || 'Failed to hash password');
    }
    return { hash: res.hash, salt: res.salt };
  }
  return hashPassword(password);
}

interface UserRow extends User {
  password_hash?: string;
  password_salt?: string;
}

const ROLE_NAMES: Record<number, string> = {
  1: 'Owner',
  2: 'Manager',
  3: 'Cashier',
  4: 'Inventory',
};

const ROLE_DEFAULTS: Record<number, PermissionSet> = {
  1: { ...OWNER_PERMISSIONS },
  2: { ...MANAGER_PERMISSIONS },
  3: { ...CASHIER_PERMISSIONS },
  4: { ...INVENTORY_PERMISSIONS },
};

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [disableTarget, setDisableTarget] = useState<UserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);

  const load = useCallback(async () => {
    const res = await query<UserRow>(
      `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id ORDER BY u.display_name`
    );
    setUsers(res.rows.map((u) => ({ ...u, permissions: parsePermissions(typeof u.permissions === 'string' ? u.permissions as string : JSON.stringify(u.permissions)) })));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDisable = async () => {
    if (!disableTarget) return;
    if (disableTarget.id === currentUser?.id) {
      toast('error', 'You cannot delete your own account');
      setDisableTarget(null);
      return;
    }
    await execute('UPDATE users SET is_active = 0 WHERE id = $1', [disableTarget.id]);
    await logAudit({ user_id: currentUser?.id ?? null, action: 'user_disable', entity_type: 'user', entity_id: disableTarget.id });
    toast('success', 'User disabled');
    setDisableTarget(null);
    load();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteUser(deleteTarget.id);
      toast('success', `User "${deleteTarget.display_name}" deleted`);
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to delete user');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">User Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage users, roles, and permissions</p>
        </div>
        <Button onClick={() => { setEditing(null); setShowModal(true); }}>
          <Plus size={18} /> Add User
        </Button>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Username</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Role</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Created</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-12 text-slate-400">
                  <UserCog size={40} className="mx-auto mb-2 opacity-40" />
                  No users found
                </td></tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="table-row-hover">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{u.display_name}</div>
                      {u.id === currentUser?.id && <span className="text-xs text-teal-600 font-medium">You</span>}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{u.username}</td>
                    <td className="px-4 py-3">
                      <Badge variant={u.role_name === 'owner' ? 'info' : 'default'}>
                        <Shield size={12} className="mr-1" />{ROLE_NAMES[u.role_id] || u.role_name}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {u.is_active === 1 ? <Badge variant="success">Active</Badge> : <Badge variant="danger">Disabled</Badge>}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-500">{new Date(u.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => { setEditing(u); setShowModal(true); }} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700">
                          <Pencil size={16} />
                        </button>
                        {u.id !== currentUser?.id && u.role_name !== 'owner' && u.is_active === 1 && (
                          <button onClick={() => setDisableTarget(u)} className="p-1.5 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600" title="Disable user">
                            <Lock size={16} />
                          </button>
                        )}
                        {u.id !== currentUser?.id && u.role_name !== 'owner' && u.is_active === 0 && (
                          <button onClick={async () => {
                            await execute('UPDATE users SET is_active = 1 WHERE id = $1', [u.id]);
                            toast('success', 'User re-enabled');
                            load();
                          }} className="p-1.5 rounded-lg text-slate-500 hover:bg-emerald-50 hover:text-emerald-600">
                            <Check size={16} />
                          </button>
                        )}
                        {u.id !== currentUser?.id && u.role_name !== 'owner' && (
                          <button onClick={() => setDeleteTarget(u)} className="p-1.5 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600" title="Delete permanently">
                            <Trash2 size={16} />
                          </button>
                        )}
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
        <UserFormModal
          user={editing}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { setShowModal(false); setEditing(null); load(); }}
        />
      )}

      <ConfirmDialog
        open={!!disableTarget}
        title="Disable User"
        message={`Disable "${disableTarget?.display_name}"? They will no longer be able to log in.`}
        confirmLabel="Disable"
        onConfirm={handleDisable}
        onCancel={() => setDisableTarget(null)}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete User Permanently"
        message={`Permanently delete "${deleteTarget?.display_name}"? This cannot be undone. Users with recorded activity must be disabled instead.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function UserFormModal({ user, onClose, onSaved }: { user: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const { user: currentUser } = useAuth();
  const [form, setForm] = useState({
    username: user?.username || '',
    display_name: user?.display_name || '',
    password: '',
    role_id: String(user?.role_id || 3),
    is_active: user ? String(user.is_active) : '1',
    permissions: user?.permissions || { ...CASHIER_PERMISSIONS },
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleRoleChange = (roleId: string) => {
    const id = parseInt(roleId, 10);
    const defaults = ROLE_DEFAULTS[id] || { ...CASHIER_PERMISSIONS };
    setForm({ ...form, role_id: roleId, permissions: { ...defaults } });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    try {
      if (!form.username.trim() || !form.display_name.trim()) {
        setError('Username and display name are required');
        setSaving(false);
        return;
      }

      const roleId = parseInt(form.role_id, 10);
      const isOwnerRole = roleId === 1;
      const perms: PermissionSet = isOwnerRole
        ? { ...OWNER_PERMISSIONS }
        : { ...form.permissions } as PermissionSet;

      if (user) {
        const prevRes = await query('SELECT * FROM users WHERE id = $1', [user.id]);
        if (form.password) {
          const { hash, salt } = await hashPasswordForStorage(form.password);
          await execute(
            `UPDATE users SET username = $1, display_name = $2, password_hash = $3, password_salt = $4, role_id = $5, is_active = $6, permissions = $7, updated_at = datetime('now') WHERE id = $8`,
            [form.username.trim(), form.display_name.trim(), hash, salt, roleId, parseInt(form.is_active), JSON.stringify(perms), user.id]
          );
        } else {
          await execute(
            `UPDATE users SET username = $1, display_name = $2, role_id = $3, is_active = $4, permissions = $5, updated_at = datetime('now') WHERE id = $6`,
            [form.username.trim(), form.display_name.trim(), roleId, parseInt(form.is_active), JSON.stringify(perms), user.id]
          );
        }
        await logAudit({ user_id: currentUser?.id ?? null, action: 'user_update', entity_type: 'user', entity_id: user.id, previous_value: JSON.stringify(prevRes.rows[0]), new_value: JSON.stringify(form) });
        toast('success', 'User updated');
      } else {
        if (!form.password) {
          setError('Password is required for new users');
          setSaving(false);
          return;
        }
        const { hash, salt } = await hashPasswordForStorage(form.password);
        const res = await query<{ id: number }>(
          `INSERT INTO users (username, password_hash, password_salt, display_name, role_id, is_active, permissions)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [form.username.trim(), hash, salt, form.display_name.trim(), roleId, parseInt(form.is_active), JSON.stringify(perms)]
        );
        await logAudit({ user_id: currentUser?.id ?? null, action: 'user_create', entity_type: 'user', entity_id: res.rows[0].id, new_value: JSON.stringify(form) });
        toast('success', 'User created');
      }
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save user';
      setError(msg.includes('unique') || msg.includes('UNIQUE') ? 'Username already exists' : msg);
      setSaving(false);
    }
  };

  const isOwner = form.role_id === '1';

  return (
    <Modal open onClose={onClose} title={user ? 'Edit User' : 'Add User'} size="lg" footer={
      <>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={saving}>{saving ? 'Saving...' : 'Save User'}</Button>
      </>
    }>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}
        <div className="grid grid-cols-2 gap-4">
          <Input label="Username *" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
          <Input label="Display Name *" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input label={user ? 'New Password (leave blank to keep)' : 'Password *'} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required={!user} />
          <Select label="Role" value={form.role_id} onChange={(e) => handleRoleChange(e.target.value)}>
            <option value="1">Store Owner</option>
            <option value="2">Manager</option>
            <option value="3">Cashier</option>
            <option value="4">Inventory Employee</option>
          </Select>
        </div>
        {user && (
          <Select label="Status" value={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.value })}>
            <option value="1">Active</option>
            <option value="0">Disabled</option>
          </Select>
        )}

        {!isOwner && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-3">Permissions</label>
            <div className="grid grid-cols-2 gap-2 max-h-[300px] overflow-y-auto scrollbar-thin p-3 border border-slate-200 rounded-lg">
              {ALL_PERMISSIONS.map((perm) => (
                <label key={perm} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!form.permissions[perm]}
                    onChange={(e) => setForm({
                      ...form,
                      permissions: { ...form.permissions, [perm]: e.target.checked }
                    })}
                    className="rounded"
                  />
                  <span className="capitalize">{perm.replace(/\./g, ' — ')}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {isOwner && (
          <div className="bg-teal-50 border border-teal-200 rounded-lg p-3 text-sm text-teal-700">
            <Shield size={16} className="inline mr-2" />
            Store Owner has full access to all features and permissions.
          </div>
        )}
      </form>
    </Modal>
  );
}
