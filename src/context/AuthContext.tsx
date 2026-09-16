import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { query, execute, setAuthSessionId } from '@/db/client';
import { verifyPassword } from '@/lib/crypto';
import { parsePermissions, type PermissionSet, type Permission } from '@/lib/permissions';
import type { User } from '@/types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  hasPermission: (perm: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = 'elakrammen_current_user_id';
const SESSION_KEY = 'elakrammen_session_id';
const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const storedUserId = localStorage.getItem(STORAGE_KEY);
      const storedSessionId = localStorage.getItem(SESSION_KEY);
      if (storedUserId && storedSessionId) {
        if (isElectron) {
          // Restore via IPC — requires the previous sessionId (still live
          // in the main-process session map). A bare userId is NOT accepted.
          const res = await window.electronAPI.auth.restore(parseInt(storedSessionId, 10));
          if (res.success && res.user && res.sessionId) {
            setAuthSessionId(res.sessionId);
            localStorage.setItem(SESSION_KEY, String(res.sessionId));
            setUser(mapAuthUser(res.user));
          } else {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(SESSION_KEY);
          }
        } else {
          // Browser fallback — just load user from DB
          const res = await query<{ id: number; username: string; display_name: string; role_id: number; role_name: string; is_active: number; permissions: string; created_at: string; updated_at: string }>(
            `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1`,
            [parseInt(storedUserId, 10)]
          );
          if (res.rows.length > 0 && res.rows[0].is_active === 1) {
            const row = res.rows[0];
            setUser({ ...row, permissions: parsePermissions(row.permissions) });
          } else {
            localStorage.removeItem(STORAGE_KEY);
          }
        }
      }
      setLoading(false);
    })();
  }, []);

  const login = async (username: string, password: string) => {
    if (isElectron) {
      const res = await window.electronAPI.auth.login(username, password);
      if (!res.success || !res.user || res.sessionId === undefined) {
        return { success: false, error: res.error || 'Login failed' };
      }
      setAuthSessionId(res.sessionId);
      localStorage.setItem(STORAGE_KEY, String(res.user.id));
      localStorage.setItem(SESSION_KEY, String(res.sessionId));
      setUser(mapAuthUser(res.user));
      return { success: true };
    }

    // Browser fallback (PGlite)
    const res = await query<{ id: number; username: string; display_name: string; role_id: number; role_name: string; is_active: number; password_hash: string; password_salt: string; permissions: string; created_at: string; updated_at: string }>(
      `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.username = $1`,
      [username]
    );
    if (res.rows.length === 0) {
      return { success: false, error: 'User not found' };
    }
    const row = res.rows[0];
    if (row.is_active !== 1) {
      return { success: false, error: 'This account is disabled. Contact the administrator.' };
    }
    const valid = await verifyPassword(password, row.password_hash, row.password_salt);
    if (!valid) {
      return { success: false, error: 'Incorrect password' };
    }
    setUser({
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      role_id: row.role_id,
      role_name: row.role_name,
      is_active: row.is_active,
      permissions: parsePermissions(row.permissions),
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
    localStorage.setItem(STORAGE_KEY, String(row.id));

    const sessionRes = await query<{ id: number }>(
      'INSERT INTO user_sessions (user_id) VALUES ($1) RETURNING id',
      [row.id]
    );
    localStorage.setItem(SESSION_KEY, String(sessionRes.rows[0].id));

    return { success: true };
  };

  const logout = () => {
    const sessionId = localStorage.getItem(SESSION_KEY);
    if (isElectron && sessionId) {
      window.electronAPI.auth.logout(parseInt(sessionId, 10)).catch(() => { /* best-effort */ });
    } else if (sessionId && user) {
      execute(
        "UPDATE user_sessions SET logout_at = datetime('now') WHERE id = $1",
        [parseInt(sessionId, 10)]
      ).catch(() => { /* best-effort */ });
    }
    setAuthSessionId(undefined);
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  };

  const hasPermission = (perm: string) => {
    if (!user) return false;
    return !!user.permissions[perm as Permission];
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
}

function mapAuthUser(u: {
  id: number;
  username: string;
  display_name: string;
  role_id: number;
  role_name: string;
  is_active: number;
  permissions: Record<string, boolean>;
  created_at: string;
  updated_at: string;
}): User {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role_id: u.role_id,
    role_name: u.role_name,
    is_active: u.is_active,
    permissions: u.permissions as PermissionSet,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
