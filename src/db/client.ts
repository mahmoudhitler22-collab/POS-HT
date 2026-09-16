// Database client — bridges to Electron's SQLite via IPC when running in Electron,
// falls back to PGlite (IndexedDB) when running in a browser without Electron.

import { PGlite } from '@electric-sql/pglite';
import { SCHEMA_SQL, SEED_SQL, SCHEMA_VERSION } from './schema';
import type { TxStep } from '../electron.d';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

// ─── Session ID (set by AuthContext after login) ───────────
let _authSessionId: number | undefined = undefined;

export function setAuthSessionId(id: number | undefined): void {
  _authSessionId = id;
}

export function getAuthSessionId(): number | undefined {
  return _authSessionId;
}

// ─── Transaction Context ───────────────────────────────────

export interface TransactionContext {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
  exec: (sql: string, params?: unknown[]) => Promise<void>;
}

// ─── Electron (SQLite) Path ────────────────────────────────

async function electronQuery<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<{ rows: T[] }> {
  const result = await window.electronAPI.db.query(sql, params, _authSessionId);
  if (!result.success) {
    throw new Error(result.error || 'Query failed');
  }
  return { rows: (result.rows || []) as T[] };
}

async function electronExec(sql: string, params?: unknown[]): Promise<void> {
  const result = await window.electronAPI.db.exec(sql, params, _authSessionId);
  if (!result.success) {
    throw new Error(result.error || 'Execute failed');
  }
}

// Electron transaction: uses interactive transaction sessions via IPC.
// The main process opens a SAVEPOINT, the renderer runs queries/execs interactively,
// then commits or rolls back. The auth session ID is passed to txBegin so
// permission checks apply to every statement inside the transaction.

async function electronTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
  const beginRes = await window.electronAPI.db.txBegin(_authSessionId);
  if (!beginRes.success || beginRes.sessionId === undefined) {
    throw new Error(beginRes.error || 'Failed to begin transaction');
  }
  const sessionId = beginRes.sessionId;

  const tx: TransactionContext = {
    query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const res = await window.electronAPI.db.txQuery(sessionId, sql, params);
      if (!res.success) {
        throw new Error(res.error || 'Query failed in transaction');
      }
      return { rows: (res.rows || []) as R[] };
    },
    exec: async (sql: string, params?: unknown[]) => {
      const res = await window.electronAPI.db.txExec(sessionId, sql, params);
      if (!res.success) {
        throw new Error(res.error || 'Execute failed in transaction');
      }
    },
  };

  try {
    const result = await fn(tx);
    const commitRes = await window.electronAPI.db.txCommit(sessionId);
    if (!commitRes.success) {
      throw new Error(commitRes.error || 'Commit failed');
    }
    return result;
  } catch (err) {
    await window.electronAPI.db.txRollback(sessionId);
    throw err;
  }
}

// ─── PGlite (Browser Fallback) Path ────────────────────────

let dbInstance: PGlite | null = null;
let initPromise: Promise<PGlite> | null = null;

async function seedOwnerAccountPglite(db: PGlite): Promise<void> {
  const existing = await db.query<{ count: string }>("SELECT COUNT(*) as count FROM users WHERE username = 'mahmoud'");
  if (parseInt(existing.rows[0].count, 10) > 0) return;

  const { hashPassword } = await import('@/lib/crypto');
  const { OWNER_PERMISSIONS } = await import('@/lib/permissions');
  const { hash, salt } = await hashPassword('Mahmoud79');
  await db.query(
    `INSERT INTO users (username, password_hash, password_salt, display_name, role_id, permissions)
     VALUES ($1, $2, $3, $4, 1, $5)`,
    ['mahmoud', hash, salt, 'Mahmoud', JSON.stringify(OWNER_PERMISSIONS)]
  );
}

async function getPglite(): Promise<PGlite> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const db = new PGlite('idb://elakrammen-pos');
    await db.exec(SCHEMA_SQL);
    await db.exec(SEED_SQL);
    await runPgliteMigrations(db);
    await seedOwnerAccountPglite(db);
    dbInstance = db;
    return db;
  })();

  return initPromise;
}

async function runPgliteMigrations(db: PGlite): Promise<void> {
  const result = await db.query<{ value: string }>(
    "SELECT value FROM schema_meta WHERE key = 'version'"
  );
  const currentVersion = result.rows.length > 0 ? parseInt(result.rows[0].value, 10) : 0;

  if (currentVersion < SCHEMA_VERSION) {
    await db.query(
      `UPDATE schema_meta SET value = $1 WHERE key = 'version'`,
      [String(SCHEMA_VERSION)]
    );
  }
}

async function pgliteQuery<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<{ rows: T[] }> {
  const db = await getPglite();
  return db.query<T>(sql, params as never[]);
}

async function pgliteExec(sql: string, params?: unknown[]): Promise<void> {
  const db = await getPglite();
  if (params && params.length > 0) {
    await db.query(sql, params as never[]);
  } else {
    await db.exec(sql);
  }
}

async function pgliteTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
  const db = await getPglite();
  await db.exec('BEGIN');
  try {
    const tx: TransactionContext = {
      query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) =>
        db.query<R>(sql, params as never[]),
      exec: async (sql: string, params?: unknown[]) => {
        if (params && params.length > 0) {
          await db.query(sql, params as never[]);
        } else {
          await db.exec(sql);
        }
      },
    };
    const result = await fn(tx);
    await db.exec('COMMIT');
    return result;
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
}

// ─── Public API (auto-selects Electron or PGlite) ──────────

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<{ rows: T[] }> {
  if (isElectron) {
    return electronQuery<T>(sql, params);
  }
  return pgliteQuery<T>(sql, params);
}

export async function execute(sql: string, params?: unknown[]): Promise<void> {
  if (isElectron) {
    return electronExec(sql, params);
  }
  return pgliteExec(sql, params);
}

export async function transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
  if (isElectron) {
    return electronTransaction(fn);
  }
  return pgliteTransaction(fn);
}

export function isRunningInElectron(): boolean {
  return isElectron;
}
