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
    if (currentVersion < 5) {
      await migrateVariantsToProductsPglite(db);
    }
    await db.query(
      `UPDATE schema_meta SET value = $1 WHERE key = 'version'`,
      [String(SCHEMA_VERSION)]
    );
  }
}

async function migrateVariantsToProductsPglite(db: PGlite): Promise<void> {
  // Add model_name column if it doesn't exist
  const cols = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'model_name'`
  );
  if (cols.rows.length === 0) {
    await db.exec("ALTER TABLE products ADD COLUMN model_name TEXT NOT NULL DEFAULT ''");
  }

  // Set model_name = name for all existing products
  await db.exec("UPDATE products SET model_name = name WHERE model_name = '' OR model_name IS NULL");

  // Check if product_variants table exists and has rows
  const tableCheck = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'product_variants') as exists`
  );
  if (!tableCheck.rows[0]?.exists) return;

  const variantCount = await db.query<{ count: string }>('SELECT COUNT(*) AS count FROM product_variants');
  if (parseInt(variantCount.rows[0]?.count ?? '0', 10) === 0) return;

  const variants = await db.query<{
    variant_id: number; product_id: number; color: string | null; size: string | null;
    barcode: string | null; purchase_cost: number | null; selling_price: number | null;
    quantity: number; min_stock_level: number; parent_name: string; model_name: string;
    brand_id: number | null; category_id: number | null; type: string | null;
    supplier_id: number | null; notes: string | null; is_active: number;
  }>(
    `SELECT pv.id AS variant_id, pv.product_id, pv.color, pv.size, pv.barcode,
            pv.purchase_cost, pv.selling_price, pv.quantity, pv.min_stock_level,
            p.name AS parent_name, p.model_name, p.brand_id, p.category_id,
            p.type, p.supplier_id, p.notes, p.is_active
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id`
  );

  for (const v of variants.rows) {
    const color = v.color || '';
    const size = v.size || '';
    const parts = [v.model_name, color, size].filter(Boolean);
    const newName = parts.join(' - ');
    const cost = v.purchase_cost ?? 0;
    const price = v.selling_price ?? 0;

    const insertRes = await db.query<{ id: number }>(
      `INSERT INTO products (name, model_name, sku, barcode, brand_id, category_id, type, size, color,
         purchase_cost, selling_price, quantity, min_stock_level, supplier_id, notes, is_active)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [newName, v.model_name, v.barcode, v.brand_id, v.category_id, v.type,
       v.size, v.color, cost, price, v.quantity, v.min_stock_level,
       v.supplier_id, v.notes, v.is_active]
    );
    const newProductId = insertRes.rows[0].id;

    await db.query('UPDATE sale_items SET product_id = $1, variant_id = NULL WHERE variant_id = $2', [newProductId, v.variant_id]);
    await db.query('UPDATE refund_items SET product_id = $1, variant_id = NULL WHERE variant_id = $2', [newProductId, v.variant_id]);
    await db.query('UPDATE inventory_movements SET product_id = $1, variant_id = NULL WHERE variant_id = $2', [newProductId, v.variant_id]);
    await db.query('UPDATE barcode_labels SET product_id = $1, variant_id = NULL WHERE variant_id = $2', [newProductId, v.variant_id]);
  }

  // Deactivate old parent products
  const parentIds = [...new Set(variants.rows.map((v) => v.product_id))];
  for (const pid of parentIds) {
    await db.query('UPDATE products SET is_active = 0 WHERE id = $1', [pid]);
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

// PGlite has ONE connection, so two overlapping BEGIN … COMMIT blocks (e.g. two sale tabs
// completing at the same moment) would be merged into a single transaction. Run them one at a time.
let pgliteTxQueue: Promise<unknown> = Promise.resolve();

function pgliteTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
  const run = pgliteTxQueue.then(() => runPgliteTransaction(fn));
  pgliteTxQueue = run.catch(() => undefined);
  return run;
}

async function runPgliteTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
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
