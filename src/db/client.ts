// Database client — bridges to Electron's SQLite via IPC when running in Electron,
// falls back to PGlite (IndexedDB) when running in a browser without Electron.

import { PGlite } from '@electric-sql/pglite';
import { PGLITE_SCHEMA_SQL, PGLITE_SEED_SQL, SCHEMA_VERSION } from './schema';

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

async function getPglite(): Promise<PGlite> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const db = new PGlite('idb://elakrammen-pos');
    await db.exec(PGLITE_SCHEMA_SQL);
    await db.exec(PGLITE_SEED_SQL);
    await runPgliteMigrations(db);
    dbInstance = db;
    return db;
  })();

  return initPromise;
}

export async function isInitialOwnerSetupRequired(): Promise<boolean> {
  if (isRunningInElectron()) return false;
  const db = await getPglite();
  const result = await db.query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
  return parseInt(result.rows[0]?.count ?? '0', 10) === 0;
}

export async function createInitialOwner(username: string, displayName: string, password: string): Promise<{ success: boolean; error?: string }> {
  if (isRunningInElectron()) return { success: false, error: 'Initial setup is handled by the desktop application.' };
  if (!username.trim() || !displayName.trim() || password.length < 10) {
    return { success: false, error: 'Enter a username, a display name, and a password of at least 10 characters.' };
  }

  const db = await getPglite();
  const existing = await db.query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
  if (parseInt(existing.rows[0]?.count ?? '0', 10) > 0) return { success: false, error: 'An owner account already exists.' };

  const { hashPassword } = await import('@/lib/crypto');
  const { OWNER_PERMISSIONS } = await import('@/lib/permissions');
  const { hash, salt } = await hashPassword(password);
  await db.query(
    `INSERT INTO users (username, password_hash, password_salt, display_name, role_id, must_change_password, permissions)
     VALUES ($1, $2, $3, $4, 1, 0, $5)`,
    [username.trim(), hash, salt, displayName.trim(), JSON.stringify(OWNER_PERMISSIONS)]
  );
  return { success: true };
}

async function runPgliteMigrations(db: PGlite): Promise<void> {
  const result = await db.query<{ value: string }>(
    "SELECT value FROM schema_meta WHERE key = 'version'"
  );
  const currentVersion = result.rows.length > 0 ? parseInt(result.rows[0].value, 10) : 0;

  if (currentVersion < SCHEMA_VERSION) {
    if (currentVersion < 4) {
      await db.exec('ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INTEGER NOT NULL DEFAULT 0');
    }
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

/** Permanently remove a product that has no sales or refund history. */
export async function deleteProduct(productId: number): Promise<void> {
  if (isElectron) {
    const result = await window.electronAPI.db.deleteProduct(productId, _authSessionId);
    if (!result.success) throw new Error(result.error || 'Failed to delete product');
    return;
  }

  const product = await query<{ id: number }>('SELECT id FROM products WHERE id = $1', [productId]);
  if (!product.rows[0]) {
    throw new Error('Product not found');
  }

  const history = await query<{ count: number }>(
    `SELECT COUNT(*) AS count FROM (
       SELECT product_id FROM sale_items WHERE product_id = $1
       UNION ALL
       SELECT product_id FROM refund_items WHERE product_id = $1
     ) AS product_history`,
    [productId],
  );
  if (Number(history.rows[0]?.count ?? 0) > 0) {
    throw new Error('Products with sales or refunds cannot be deleted. Archive the product instead.');
  }

  await transaction(async (tx) => {
    await tx.exec('DELETE FROM barcode_labels WHERE product_id = $1', [productId]);
    await tx.exec('DELETE FROM inventory_movements WHERE product_id = $1', [productId]);
    await tx.exec('DELETE FROM product_variants WHERE product_id = $1', [productId]);
    await tx.exec('DELETE FROM products WHERE id = $1', [productId]);
  });
}

/** Permanently remove a non-owner user without recorded business activity. */
export async function deleteUser(userId: number): Promise<void> {
  if (isElectron) {
    const result = await window.electronAPI.db.deleteUser(userId, _authSessionId);
    if (!result.success) throw new Error(result.error || 'Failed to delete user');
    return;
  }

  const target = await query<{ role_name: string }>(
    'SELECT r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1',
    [userId],
  );
  if (!target.rows[0]) {
    throw new Error('User not found');
  }
  if (target.rows[0]?.role_name === 'owner') {
    throw new Error('The primary owner account cannot be deleted');
  }

  const history = await query<{ count: number }>(
    `SELECT COUNT(*) AS count FROM (
       SELECT cashier_id AS user_id FROM sales WHERE cashier_id = $1
       UNION ALL SELECT cashier_id FROM refunds WHERE cashier_id = $1
       UNION ALL SELECT user_id FROM expenses WHERE user_id = $1
       UNION ALL SELECT user_id FROM inventory_movements WHERE user_id = $1
       UNION ALL SELECT user_id FROM barcode_labels WHERE user_id = $1
     ) AS user_history`,
    [userId],
  );
  if (Number(history.rows[0]?.count ?? 0) > 0) {
    throw new Error('Users with recorded activity cannot be deleted. Disable the account instead.');
  }

  await transaction(async (tx) => {
    await tx.exec('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
    await tx.exec('UPDATE audit_logs SET user_id = NULL WHERE user_id = $1', [userId]);
    await tx.exec('DELETE FROM users WHERE id = $1', [userId]);
  });
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
