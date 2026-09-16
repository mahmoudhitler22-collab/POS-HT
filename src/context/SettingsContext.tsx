import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { query } from '@/db/client';
import { useAuth } from '@/context/AuthContext';
import type { Setting } from '@/types';

interface SettingsContextValue {
  settings: Record<string, string>;
  loading: boolean;
  refresh: () => Promise<void>;
  get: (key: string, fallback?: string) => string;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await query<Setting>('SELECT key, value FROM settings');
      const map: Record<string, string> = {};
      for (const row of res.rows) {
        map[row.key] = row.value;
      }
      setSettings(map);
    } catch {
      // Settings load failed — keep existing/default settings rather than crashing
    }
    setLoading(false);
  }, []);

  // Load settings only when a user is authenticated (session is ready).
  // Before login, _authSessionId is undefined and session-protected IPC calls
  // would fail. After login/restore, user becomes non-null and we load.
  // On logout, user becomes null and we clear to defaults.
  useEffect(() => {
    if (user) {
      refresh();
    } else {
      setSettings({});
      setLoading(false);
    }
  }, [user, refresh]);

  const get = (key: string, fallback = '') => settings[key] ?? fallback;

  return (
    <SettingsContext.Provider value={{ settings, loading, refresh, get }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
