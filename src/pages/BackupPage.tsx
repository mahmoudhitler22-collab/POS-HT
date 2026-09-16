import { useState, useEffect, useCallback } from 'react';
import { query, getAuthSessionId } from '@/db/client';
import { useAuth } from '@/context/AuthContext';
import { logAudit } from '@/lib/audit';
import { formatEgp } from '@/lib/money';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import type { BackupInfo } from '@/electron.d';
import {
  DatabaseBackup, Download, Upload, Trash2, HardDrive,
  Shield, Clock, AlertTriangle
} from 'lucide-react';

export function BackupPage() {
  const { user } = useAuth();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [dbPath, setDbPath] = useState('');
  const [backupDir, setBackupDir] = useState('');
  const [loading, setLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupInfo | null>(null);

  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

  const load = useCallback(async () => {
    setLoading(true);
    if (isElectron) {
      const sid = getAuthSessionId();
      const [infoRes, backupRes] = await Promise.all([
        window.electronAPI.db.getInfo(sid),
        window.electronAPI.db.listBackups(sid),
      ]);
      if (infoRes.success && infoRes.path) setDbPath(infoRes.path);
      if (infoRes.success && infoRes.backupDir) setBackupDir(infoRes.backupDir || '');
      if (backupRes.success && backupRes.backups) setBackups(backupRes.backups);
    } else {
      setDbPath('Browser mode (PGlite/IndexedDB)');
      setBackupDir('N/A in browser mode');
    }
    setLoading(false);
  }, [isElectron]);

  useEffect(() => { load(); }, [load]);

  const createBackup = async () => {
    if (isElectron) {
      const res = await window.electronAPI.db.backup(`manual_${Date.now()}`, getAuthSessionId());
      if (res.success) {
        toast('success', 'Backup created successfully');
        load();
      } else {
        toast('error', res.error || 'Backup failed');
      }
    } else {
      toast('info', 'Backup is only available in the desktop application');
    }
  };

  const saveBackupTo = async () => {
    if (!isElectron) {
      toast('info', 'This feature is only available in the desktop application');
      return;
    }
    const res = await window.electronAPI.db.saveBackupTo(getAuthSessionId());
    if (res.canceled) return;
    if (res.success) {
      toast('success', `Backup saved to ${res.path}`);
      await logAudit({ user_id: user?.id ?? null, action: 'database_export', entity_type: 'backup', new_value: res.path || '' });
    } else {
      toast('error', res.error || 'Export failed');
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget || !isElectron) return;
    const res = await window.electronAPI.db.restore(restoreTarget.path, getAuthSessionId());
    if (res.success) {
      toast('success', 'Database restored successfully. Please restart the application.');
      await logAudit({ user_id: user?.id ?? null, action: 'database_restore', entity_type: 'backup', new_value: restoreTarget.path });
    } else {
      toast('error', res.error || 'Restore failed');
    }
    setRestoreTarget(null);
    load();
  };

  const handleDelete = async () => {
    if (!deleteTarget || !isElectron) return;
    const res = await window.electronAPI.db.deleteBackup(deleteTarget.path, getAuthSessionId());
    if (res.success) {
      toast('success', 'Backup deleted');
    } else {
      toast('error', res.error || 'Failed to delete backup');
    }
    setDeleteTarget(null);
    load();
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Backup & Restore</h1>
          <p className="text-sm text-slate-500 mt-0.5">Protect your store data with backups</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={createBackup} disabled={loading}>
            <DatabaseBackup size={18} /> Create Backup
          </Button>
          <Button variant="outline" onClick={saveBackupTo} disabled={loading}>
            <Download size={18} /> Save Backup To...
          </Button>
        </div>
      </div>

      {/* Database Info */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <HardDrive size={20} className="text-blue-600" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Database Location</p>
              <p className="text-sm font-mono text-slate-900 truncate" title={dbPath}>{dbPath || 'Loading...'}</p>
            </div>
          </div>
          <p className="text-xs text-slate-400">
            The database is stored in the user's application data directory, separate from the application installation. It survives updates and reinstalls.
          </p>
        </div>
        <div className="card p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
              <Shield size={20} className="text-emerald-600" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Backup Directory</p>
              <p className="text-sm font-mono text-slate-900 truncate" title={backupDir}>{backupDir || 'Loading...'}</p>
            </div>
          </div>
          <p className="text-xs text-slate-400">
            All backups are stored locally. A backup is automatically created before any database migration.
          </p>
        </div>
      </div>

      {!isElectron && (
        <div className="card p-4 bg-amber-50 border-amber-200">
          <div className="flex items-center gap-2 text-sm text-amber-700">
            <AlertTriangle size={18} />
            You are running in browser mode. Backup and restore features are available in the desktop application only.
          </div>
        </div>
      )}

      {/* Backups List */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200">
          <h3 className="font-semibold text-slate-900">Available Backups ({backups.length})</h3>
        </div>
        {backups.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <DatabaseBackup size={40} className="mx-auto mb-2 opacity-40" />
            <p>No backups yet</p>
            <p className="text-xs mt-1">Click "Create Backup" to make your first backup</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {backups.map((b) => (
              <div key={b.path} className="flex items-center justify-between p-4 hover:bg-slate-50">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center">
                    <DatabaseBackup size={18} className="text-slate-600" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-900">{b.name}</p>
                    <div className="flex items-center gap-3 text-xs text-slate-400">
                      <span className="flex items-center gap-1"><Clock size={12} />{new Date(b.date).toLocaleString()}</span>
                      <span>{formatSize(b.size)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setRestoreTarget(b)}>
                    <Upload size={16} /> Restore
                  </Button>
                  <button onClick={() => setDeleteTarget(b)} className="p-1.5 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!restoreTarget}
        title="Restore Database"
        message={`Restore from "${restoreTarget?.name}"? This will replace the current database. A safety backup will be created automatically before the restore.`}
        confirmLabel="Restore"
        variant="primary"
        onConfirm={handleRestore}
        onCancel={() => setRestoreTarget(null)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Backup"
        message={`Delete backup "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
