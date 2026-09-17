import { ipcMain, BrowserWindow, dialog } from 'electron';
import { copyFileSync } from 'fs';
import { getDb, createBackup, restoreFromBackup, listBackups, deleteBackup, getDatabasePath, getBackupDir } from './database';
import { BrowserWindow as BW } from 'electron';
import {
  login, logout, restoreSession, checkSqlPermission, isSelectSql,
  requirePermission, hasPermission, getSession, hashPassword,
} from './auth';
import os from 'os';

export interface TxStep {
  type: 'query' | 'exec';
  sql: string;
  params?: unknown[];
}

// ─── SQL Parameter Conversion ─────────────────────────────
// The renderer writes PostgreSQL-style positional params ($1, $2, ...)
// for PGlite compatibility. better-sqlite3 uses ? for positional params.
//
// A positional parameter may appear more than once, e.g.
//   WHERE name LIKE $1 OR sku LIKE $1
// Replacing both occurrences with ? is not enough: SQLite then expects the
// value twice. Expand the binding array in the same order as the resulting
// placeholders so repeated parameters remain valid.
function convertSql(sql: string, params: unknown[] = []): { sql: string; params: unknown[] } {
  let usesPostgresParams = false;
  const sqliteParams: unknown[] = [];

  const convertedSql = sql.replace(/\$(\d+)/g, (_match, position: string) => {
    usesPostgresParams = true;
    const index = Number(position) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= params.length) {
      throw new Error(`Missing value for SQL parameter $${position}`);
    }
    sqliteParams.push(params[index]);
    return '?';
  });

  return {
    sql: convertedSql,
    params: usesPostgresParams ? sqliteParams : params,
  };
}

export interface TxResult {
  success: boolean;
  results?: unknown[];
  error?: string;
}

// ─── Interactive Transaction Sessions ─────────────────────
// Each session carries the auth sessionId for permission checks.

interface TxSession {
  id: number;
  savepointName: string;
  authSessionId: number;
}

const txSessions = new Map<number, TxSession>();
let txSessionCounter = 0;

// Interactive transactions share one SQLite connection. Savepoints are
// connection-scoped, so overlapping transactions could otherwise nest and
// accidentally commit or release each other. Keep one interactive
// transaction active at a time and queue the rest.
let activeTxId: number | null = null;
const txWaiters: Array<() => void> = [];

async function acquireTransactionSlot(id: number): Promise<void> {
  if (activeTxId === null) {
    activeTxId = id;
    return;
  }

  await new Promise<void>((resolve) => txWaiters.push(resolve));
  activeTxId = id;
}

function releaseTransactionSlot(id: number): void {
  if (activeTxId !== id) return;
  const next = txWaiters.shift();
  if (next) {
    next();
  } else {
    activeTxId = null;
  }
}

// ─── Helper: validate session and return SessionInfo or error ─
// Every protected handler starts with this check. If the session is
// missing or invalid, we return an auth error before touching the DB.
function validateSession(sessionId: number | undefined): { ok: true; session: NonNullable<ReturnType<typeof getSession>> } | { ok: false; error: string } {
  const session = getSession(sessionId);
  if (!session) {
    return { ok: false, error: 'Not authenticated. Please log in again.' };
  }
  return { ok: true, session };
}

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {

  // ─── Auth: Login ──────────────────────────────────────────
  // No session required — this is how you get one.
  ipcMain.handle('auth:login', async (_event, username: string, password: string) => {
    const result = login(username, password);
    return result;
  });

  // ─── Auth: Logout ─────────────────────────────────────────
  // Requires a valid session (so we can mark it logged-out in the DB).
  ipcMain.handle('auth:logout', async (_event, sessionId: number) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, error: validation.error };
    logout(sessionId);
    return { success: true };
  });

  // ─── Auth: Restore session (for page reload) ──────────────
  // The renderer must pass the *previous* sessionId that is still live
  // in our in-memory map. A bare userId is NOT accepted.
  ipcMain.handle('auth:restore', async (_event, previousSessionId: number) => {
    return restoreSession(previousSessionId);
  });

  // ─── Auth: Check permission ───────────────────────────────
  ipcMain.handle('auth:hasPermission', async (_event, sessionId: number, perm: string) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, result: false };
    return { success: true, result: hasPermission(sessionId, perm) };
  });

  // ─── Auth: Hash password (requires valid session) ─────────
  // Lets the renderer hash passwords with scrypt in the main process,
  // ensuring the same algorithm is used for creating users, changing
  // passwords, and verifying login. Falls back to PBKDF2 in the
  // browser (PGlite) path.
  ipcMain.handle('auth:hashPassword', async (_event, sessionId: number, password: string) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, error: validation.error };
    const { hash, salt } = hashPassword(password);
    return { success: true, hash, salt };
  });

  // ─── Complete sale (requires 'pos') ───────────────────────
  // This is intentionally a narrow API instead of a renderer-controlled
  // sequence of SQL statements.  It permits a POS user to perform the sale
  // as one atomic operation without granting settings, inventory, or profit
  // permissions to that user.
  ipcMain.handle('sales:complete', async (
    _event,
    request: {
      customerId: number | null;
      paymentMethod: string;
      globalDiscount: { type: 'percentage' | 'fixed' | 'none'; value: number };
      items: Array<{ productId: number; quantity: number; discountType: 'percentage' | 'fixed' | null; discountValue: number }>;
    },
    sessionId?: number,
  ) => {
    try {
      const validation = validateSession(sessionId);
      if (!validation.ok) return { success: false, error: validation.error };
      const permission = requirePermission(sessionId!, 'pos');
      if (!permission.ok) return { success: false, error: permission.error };
      if (!Array.isArray(request.items) || request.items.length === 0) {
        return { success: false, error: 'A sale must contain at least one item' };
      }
      if (typeof request.paymentMethod !== 'string' || !request.paymentMethod.trim()) {
        return { success: false, error: 'A payment method is required' };
      }

      const db = getDb();
      const sale = db.transaction(() => {
        const settings = new Map(
          (db.prepare("SELECT key, value FROM settings WHERE key IN ('invoice_counter', 'invoice_prefix', 'allow_negative_stock', 'max_discount_percentage', 'loyalty_enabled', 'loyalty_points_per_1000_egp')").all() as Array<{ key: string; value: string }>)
            .map((row) => [row.key, row.value]),
        );
        const maxDiscount = Number.parseInt(settings.get('max_discount_percentage') ?? '20', 10);
        const allowNegativeStock = settings.get('allow_negative_stock') === '1';
        const seenProducts = new Set<number>();
        const items = request.items.map((input) => {
          if (!Number.isInteger(input.productId) || seenProducts.has(input.productId)) {
            throw new Error('Each product may appear only once in a sale');
          }
          seenProducts.add(input.productId);
          if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new Error('Sale quantities must be positive');
          if (!Number.isFinite(input.discountValue) || input.discountValue < 0) throw new Error('Discount values must be non-negative');
          if (input.discountType !== null && input.discountType !== 'percentage' && input.discountType !== 'fixed') {
            throw new Error('Invalid item discount type');
          }
          if (input.discountType === 'percentage' && input.discountValue > maxDiscount) {
            throw new Error(`Maximum discount is ${maxDiscount}%`);
          }

          const product = db.prepare('SELECT id, name, selling_price, purchase_cost, quantity, is_active FROM products WHERE id = ?').get(input.productId) as
            | { id: number; name: string; selling_price: number; purchase_cost: number; quantity: number; is_active: number }
            | undefined;
          if (!product || product.is_active !== 1) throw new Error('One or more products are unavailable');
          if (!allowNegativeStock && product.quantity < input.quantity) {
            throw new Error(`Insufficient stock for ${product.name}`);
          }

          const gross = product.selling_price * input.quantity;
          const itemDiscount = input.discountType === 'percentage'
            ? Math.round(gross * input.discountValue / 100)
            : input.discountType === 'fixed'
              ? Math.min(Math.round(input.discountValue * 100), gross)
              : 0;
          return { ...input, product, gross, itemDiscount, afterItemDiscount: gross - itemDiscount };
        });

        const subtotal = items.reduce((total, item) => total + item.gross, 0);
        const itemDiscounts = items.reduce((total, item) => total + item.itemDiscount, 0);
        const afterItemDiscounts = subtotal - itemDiscounts;
        const global = request.globalDiscount;
        if (!global || !Number.isFinite(global.value) || global.value < 0 || !['percentage', 'fixed', 'none'].includes(global.type)) {
          throw new Error('Invalid sale discount');
        }
        if (global.type === 'percentage' && global.value > maxDiscount) throw new Error(`Maximum discount is ${maxDiscount}%`);
        const globalDiscount = global.type === 'percentage'
          ? Math.round(afterItemDiscounts * global.value / 100)
          : global.type === 'fixed'
            ? Math.min(Math.round(global.value * 100), afterItemDiscounts)
            : 0;

        let remainingGlobalDiscount = globalDiscount;
        const pricedItems = items.map((item, index) => {
          const allocation = index === items.length - 1
            ? remainingGlobalDiscount
            : afterItemDiscounts > 0
              ? Math.min(remainingGlobalDiscount, Math.round(item.afterItemDiscount * globalDiscount / afterItemDiscounts))
              : 0;
          remainingGlobalDiscount -= allocation;
          return { ...item, discountAmount: item.itemDiscount + allocation, finalPrice: item.afterItemDiscount - allocation };
        });
        const totalDiscount = itemDiscounts + globalDiscount;
        const total = subtotal - totalDiscount;

        const counter = Number.parseInt(settings.get('invoice_counter') ?? '0', 10) + 1;
        const invoiceNumber = `${settings.get('invoice_prefix') || 'INV'}-${String(counter).padStart(6, '0')}`;
        db.prepare("UPDATE settings SET value = ? WHERE key = 'invoice_counter'").run(String(counter));

        const customerId = request.customerId === null ? null : Number.isInteger(request.customerId) ? request.customerId : (() => { throw new Error('Invalid customer'); })();
        if (customerId !== null && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) throw new Error('Customer not found');
        const saleId = (db.prepare(
          `INSERT INTO sales (invoice_number, customer_id, cashier_id, subtotal, discount_amount, total, payment_method, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'completed') RETURNING id`,
        ).get(invoiceNumber, customerId, validation.session.userId, subtotal, totalDiscount, total, request.paymentMethod.trim()) as { id: number }).id;

        const insertItem = db.prepare(
          `INSERT INTO sale_items (sale_id, product_id, product_name, unit_price, quantity, discount_type, discount_value, discount_amount, final_price, cost_at_sale, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const updateProduct = db.prepare("UPDATE products SET quantity = ?, updated_at = datetime('now') WHERE id = ?");
        const movement = db.prepare(
          `INSERT INTO inventory_movements (product_id, quantity_change, previous_quantity, new_quantity, reason, reference_type, reference_id, user_id)
           VALUES (?, ?, ?, ?, 'Sale', 'sale', ?, ?)`,
        );
        for (const item of pricedItems) {
          insertItem.run(saleId, item.product.id, item.product.name, item.product.selling_price, item.quantity, item.discountType, item.discountType === 'fixed' ? Math.round(item.discountValue * 100) : item.discountValue, item.discountAmount, item.finalPrice, item.product.purchase_cost, item.finalPrice);
          const nextQuantity = item.product.quantity - item.quantity;
          updateProduct.run(nextQuantity, item.product.id);
          movement.run(item.product.id, -item.quantity, item.product.quantity, nextQuantity, saleId, validation.session.userId);
        }
        db.prepare('INSERT INTO payments (sale_id, method, amount) VALUES (?, ?, ?)').run(saleId, request.paymentMethod.trim(), total);

        if (customerId !== null) {
          db.prepare(`UPDATE customers SET total_purchases = total_purchases + ?, purchase_count = purchase_count + 1, yearly_purchases = yearly_purchases + ?, last_purchase_date = datetime('now') WHERE id = ?`).run(total, total, customerId);
          if (settings.get('loyalty_enabled') === '1') {
            const points = Math.floor(Math.floor(total / 100) / 1000) * Number.parseInt(settings.get('loyalty_points_per_1000_egp') ?? '10', 10);
            if (points > 0) {
              db.prepare('UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?').run(points, customerId);
              db.prepare('INSERT INTO loyalty_transactions (customer_id, sale_id, points, reason) VALUES (?, ?, ?, ?)').run(customerId, saleId, points, `Sale ${invoiceNumber}`);
            }
          }
        }
        db.prepare("INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value) VALUES (?, 'sale_complete', 'sale', ?, ?)")
          .run(validation.session.userId, saleId, JSON.stringify({ invoice: invoiceNumber, total, payment_method: request.paymentMethod.trim() }));
        return { id: saleId, invoice_number: invoiceNumber, subtotal, discount_amount: totalDiscount, total, customer_id: customerId, cashier_id: validation.session.userId, payment_method: request.paymentMethod.trim(), status: 'completed', notes: null, created_at: new Date().toISOString() };
      })();
      return { success: true, sale };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Sale failed' };
    }
  });

  // ─── Process refund (requires 'refunds') ──────────────────
  // Re-validates all remaining quantities and money amounts in the same
  // database transaction, so concurrent browser windows cannot over-refund.
  ipcMain.handle('refunds:process', async (
    _event,
    request: { saleId: number; reason: string; items: Array<{ saleItemId: number; quantity: number }> },
    sessionId?: number,
  ) => {
    try {
      const validation = validateSession(sessionId);
      if (!validation.ok) return { success: false, error: validation.error };
      const permission = requirePermission(sessionId!, 'refunds');
      if (!permission.ok) return { success: false, error: permission.error };
      if (!Number.isInteger(request.saleId) || !Array.isArray(request.items) || request.items.length === 0) {
        return { success: false, error: 'A refund must include one or more sale items' };
      }

      const db = getDb();
      const refund = db.transaction(() => {
        const sale = db.prepare("SELECT id, customer_id, total, status FROM sales WHERE id = ?").get(request.saleId) as { id: number; customer_id: number | null; total: number; status: string } | undefined;
        if (!sale || sale.status !== 'completed') throw new Error('The sale is not eligible for a refund');
        const requested = new Map<number, number>();
        for (const input of request.items) {
          if (!Number.isInteger(input.saleItemId) || !Number.isFinite(input.quantity) || input.quantity <= 0 || requested.has(input.saleItemId)) {
            throw new Error('Invalid refund items');
          }
          requested.set(input.saleItemId, input.quantity);
        }

        const refundLines = [...requested.entries()].map(([saleItemId, quantity]) => {
          const item = db.prepare('SELECT id, sale_id, product_id, product_name, unit_price, quantity, final_price FROM sale_items WHERE id = ?').get(saleItemId) as
            | { id: number; sale_id: number; product_id: number; product_name: string; unit_price: number; quantity: number; final_price: number }
            | undefined;
          if (!item || item.sale_id !== sale.id) throw new Error('Refund item does not belong to this sale');
          const previous = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS quantity, COALESCE(SUM(refund_amount), 0) AS amount FROM refund_items WHERE sale_item_id = ?').get(item.id) as { quantity: number; amount: number };
          const remainingQuantity = item.quantity - Number(previous.quantity);
          const remainingAmount = item.final_price - Number(previous.amount);
          if (quantity > remainingQuantity) throw new Error(`Refund quantity for ${item.product_name} exceeds the remaining refundable quantity`);
          const amount = quantity === remainingQuantity
            ? remainingAmount
            : Math.min(remainingAmount, Math.round(item.final_price * quantity / item.quantity));
          return { item, quantity, amount };
        });
        const refundTotal = refundLines.reduce((total, line) => total + line.amount, 0);
        if (refundTotal < 0 || refundTotal > sale.total) throw new Error('Refund amount is invalid');

        const counterRow = db.prepare("SELECT value FROM settings WHERE key = 'refund_counter'").get() as { value: string } | undefined;
        const counter = Number.parseInt(counterRow?.value ?? '0', 10) + 1;
        const prefixRow = db.prepare("SELECT value FROM settings WHERE key = 'refund_prefix'").get() as { value: string } | undefined;
        const refundNumber = `${prefixRow?.value || 'RFD'}-${String(counter).padStart(6, '0')}`;
        db.prepare("UPDATE settings SET value = ? WHERE key = 'refund_counter'").run(String(counter));
        const refundId = (db.prepare(
          'INSERT INTO refunds (refund_number, sale_id, customer_id, cashier_id, total, reason) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
        ).get(refundNumber, sale.id, sale.customer_id, validation.session.userId, refundTotal, typeof request.reason === 'string' ? request.reason.trim() : '') as { id: number }).id;

        const insertItem = db.prepare('INSERT INTO refund_items (refund_id, sale_item_id, product_id, product_name, quantity, unit_price, refund_amount) VALUES (?, ?, ?, ?, ?, ?, ?)');
        const productRow = db.prepare('SELECT quantity FROM products WHERE id = ?');
        const updateProduct = db.prepare("UPDATE products SET quantity = ?, updated_at = datetime('now') WHERE id = ?");
        const movement = db.prepare("INSERT INTO inventory_movements (product_id, quantity_change, previous_quantity, new_quantity, reason, reference_type, reference_id, user_id) VALUES (?, ?, ?, ?, 'Refund', 'refund', ?, ?)");
        for (const line of refundLines) {
          const product = productRow.get(line.item.product_id) as { quantity: number } | undefined;
          if (!product) throw new Error(`Product for ${line.item.product_name} no longer exists`);
          insertItem.run(refundId, line.item.id, line.item.product_id, line.item.product_name, line.quantity, line.item.unit_price, line.amount);
          const nextQuantity = product.quantity + line.quantity;
          updateProduct.run(nextQuantity, line.item.product_id);
          movement.run(line.item.product_id, line.quantity, product.quantity, nextQuantity, refundId, validation.session.userId);
        }
        if (sale.customer_id !== null) {
          db.prepare('UPDATE customers SET total_purchases = MAX(0, total_purchases - ?) WHERE id = ?').run(refundTotal, sale.customer_id);
        }
        db.prepare("INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value) VALUES (?, 'refund_process', 'sale', ?, ?)")
          .run(validation.session.userId, sale.id, JSON.stringify({ refundNumber, refundTotal, items: refundLines.length }));
        return { id: refundId, refund_number: refundNumber, total: refundTotal };
      })();
      return { success: true, refund };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Refund failed' };
    }
  });

  // ─── Database Query (single SELECT) ──────────────────────
  // Requires a valid session. Permission is checked against the
  // SQL statement's table + operation + cost columns.
  // Falls back to stmt.run() for non-SELECT statements (INSERT/UPDATE/DELETE
  // without RETURNING) so callers that mistakenly use query() for writes
  // don't crash on better-sqlite3's stmt.all().
  ipcMain.handle('db:query', async (_event, sql: string, params?: unknown[], sessionId?: number) => {
    try {
      const validation = validateSession(sessionId);
      if (!validation.ok) return { success: false, error: validation.error, rows: [] };

      const permCheck = checkSqlPermission(sessionId!, sql);
      if (!permCheck.ok) return { success: false, error: permCheck.error, rows: [] };

      const db = getDb();
      const converted = convertSql(sql, params);
      const stmt = db.prepare(converted.sql);
      if (isSelectSql(sql)) {
        const rows = stmt.all(...converted.params);
        return { success: true, rows };
      }
      // Non-SELECT sent through query() — use run() instead of all()
      const result = stmt.run(...converted.params);
      return { success: true, rows: [], changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    } catch (err) {
      console.error('[IPC] db:query error:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Query failed', rows: [] };
    }
  });

  // ─── Database Execute (single INSERT/UPDATE/DELETE) ─────
  // Requires a valid session. Permission + cost-column checks apply.
  ipcMain.handle('db:exec', async (_event, sql: string, params?: unknown[], sessionId?: number) => {
    try {
      const validation = validateSession(sessionId);
      if (!validation.ok) return { success: false, error: validation.error };

      const permCheck = checkSqlPermission(sessionId!, sql);
      if (!permCheck.ok) return { success: false, error: permCheck.error };

      const db = getDb();
      const converted = convertSql(sql, params);
      const stmt = db.prepare(converted.sql);
      const result = stmt.run(...converted.params);
      return { success: true, changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    } catch (err) {
      console.error('[IPC] db:exec error:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Execute failed' };
    }
  });

  // ─── Transaction (batch of steps, all atomic) ───────────
  // Every step is permission-checked before any SQL runs.
  ipcMain.handle('db:runTransaction', async (_event, steps: TxStep[], sessionId?: number): Promise<TxResult> => {
    try {
      const validation = validateSession(sessionId);
      if (!validation.ok) return { success: false, error: validation.error };

      for (const step of steps) {
        const permCheck = checkSqlPermission(sessionId!, step.sql);
        if (!permCheck.ok) return { success: false, error: permCheck.error };
      }

      const db = getDb();
      const results: unknown[] = [];
      db.transaction(() => {
        for (const step of steps) {
          const converted = convertSql(step.sql, step.params);
          const stmt = db.prepare(converted.sql);
          if (step.type === 'query') {
            results.push({ rows: stmt.all(...converted.params) });
          } else {
            const r = stmt.run(...converted.params);
            results.push({ changes: r.changes, lastInsertRowid: r.lastInsertRowid });
          }
        }
      })();
      return { success: true, results };
    } catch (err) {
      console.error('[IPC] db:runTransaction error:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Transaction failed' };
    }
  });

  // ─── Interactive Transaction: Begin ──────────────────────
  // Requires a valid session — the auth sessionId is bound to the
  // transaction session so every subsequent txQuery/txExec is checked.
  ipcMain.handle('db:txBegin', async (_event, sessionId?: number) => {
    try {
      const validation = validateSession(sessionId);
      if (!validation.ok) return { success: false, error: validation.error };

      const id = ++txSessionCounter;
      await acquireTransactionSlot(id);
      try {
        const db = getDb();
        const savepointName = `tx_${id}`;
        db.exec(`SAVEPOINT ${savepointName}`);
        txSessions.set(id, { id, savepointName, authSessionId: sessionId! });
        return { success: true, sessionId: id };
      } catch (err) {
        releaseTransactionSlot(id);
        return { success: false, error: err instanceof Error ? err.message : 'Failed to begin transaction' };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to begin transaction' };
    }
  });

  // ─── Interactive Transaction: Query ─────────────────────
  ipcMain.handle('db:txQuery', async (_event, txId: number, sql: string, params?: unknown[]) => {
    try {
      const txSession = txSessions.get(txId);
      if (!txSession) return { success: false, error: 'Transaction session not found', rows: [] };

      const permCheck = checkSqlPermission(txSession.authSessionId, sql);
      if (!permCheck.ok) return { success: false, error: permCheck.error, rows: [] };

      const db = getDb();
      const converted = convertSql(sql, params);
      const stmt = db.prepare(converted.sql);
      if (isSelectSql(sql)) {
        const rows = stmt.all(...converted.params);
        return { success: true, rows };
      }
      // Non-SELECT sent through txQuery — use run() instead of all()
      const result = stmt.run(...converted.params);
      return { success: true, rows: [], changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    } catch (err) {
      const txSession = txSessions.get(txId);
      if (txSession) {
        try { getDb().exec(`ROLLBACK TO ${txSession.savepointName}`); getDb().exec(`SAVEPOINT ${txSession.savepointName}`); } catch { /* ignore */ }
      }
      return { success: false, error: err instanceof Error ? err.message : 'Query failed', rows: [] };
    }
  });

  // ─── Interactive Transaction: Exec ───────────────────────
  ipcMain.handle('db:txExec', async (_event, txId: number, sql: string, params?: unknown[]) => {
    try {
      const txSession = txSessions.get(txId);
      if (!txSession) return { success: false, error: 'Transaction session not found' };

      const permCheck = checkSqlPermission(txSession.authSessionId, sql);
      if (!permCheck.ok) return { success: false, error: permCheck.error };

      const db = getDb();
      const converted = convertSql(sql, params);
      const stmt = db.prepare(converted.sql);
      const result = stmt.run(...converted.params);
      return { success: true, changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    } catch (err) {
      const txSession = txSessions.get(txId);
      if (txSession) {
        try { getDb().exec(`ROLLBACK TO ${txSession.savepointName}`); getDb().exec(`SAVEPOINT ${txSession.savepointName}`); } catch { /* ignore */ }
      }
      return { success: false, error: err instanceof Error ? err.message : 'Execute failed' };
    }
  });

  // ─── Interactive Transaction: Commit ─────────────────────
  ipcMain.handle('db:txCommit', async (_event, txId: number) => {
    try {
      const session = txSessions.get(txId);
      if (!session) return { success: false, error: 'Transaction session not found' };
      getDb().exec(`RELEASE ${session.savepointName}`);
      txSessions.delete(txId);
      releaseTransactionSlot(txId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Commit failed' };
    }
  });

  // ─── Interactive Transaction: Rollback ──────────────────
  ipcMain.handle('db:txRollback', async (_event, txId: number) => {
    try {
      const session = txSessions.get(txId);
      if (!session) return { success: false, error: 'Transaction session not found' };
      getDb().exec(`ROLLBACK TO ${session.savepointName}`);
      getDb().exec(`RELEASE ${session.savepointName}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Rollback failed' };
    } finally {
      txSessions.delete(txId);
      releaseTransactionSlot(txId);
    }
  });

  // ─── Product Creation (requires 'products.add') ────────────
  // Allows Inventory Employee to create a product + initial stock movement
  // + audit log atomically, without granting general 'inventory' permission.
  // The server validates all inputs; the renderer cannot bypass this.
  ipcMain.handle('db:createProduct', async (
    _event,
    product: {
      name: string;
      sku: string | null;
      barcode: string | null;
      category_id: number | null;
      brand_id: number | null;
      type: string | null;
      size: string | null;
      color: string | null;
      purchase_cost: number;
      selling_price: number;
      quantity: number;
      min_stock_level: number;
      supplier_id: number | null;
      notes: string | null;
    },
    sessionId?: number,
  ): Promise<{ success: boolean; productId?: number; error?: string }> => {
    try {
      const validation = validateSession(sessionId);
      if (!validation.ok) return { success: false, error: validation.error };

      const permCheck = requirePermission(sessionId!, 'products.add');
      if (!permCheck.ok) return { success: false, error: permCheck.error };

      // Server-side validation
      if (!product.name || !product.name.trim()) {
        return { success: false, error: 'Product name is required' };
      }
      if (product.selling_price <= 0) {
        return { success: false, error: 'Selling price must be greater than zero' };
      }
      if (product.purchase_cost < 0) {
        return { success: false, error: 'Purchase cost cannot be negative' };
      }
      if (product.quantity < 0) {
        return { success: false, error: 'Initial stock quantity cannot be negative' };
      }

      const session = getSession(sessionId!)!;
      const db = getDb();

      const result = db.transaction(() => {
        const insertProduct = db.prepare(
          `INSERT INTO products (name, sku, barcode, category_id, brand_id, type, size, color, purchase_cost, selling_price, quantity, min_stock_level, supplier_id, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const info = insertProduct.run(
          product.name.trim(),
          product.sku || null,
          product.barcode || null,
          product.category_id || null,
          product.brand_id || null,
          product.type || null,
          product.size || null,
          product.color || null,
          product.purchase_cost,
          product.selling_price,
          product.quantity,
          product.min_stock_level,
          product.supplier_id || null,
          product.notes || null,
        );
        const newId = Number(info.lastInsertRowid);

        if (product.quantity > 0) {
          db.prepare(
            `INSERT INTO inventory_movements (product_id, quantity_change, previous_quantity, new_quantity, reason, reference_type, reference_id, user_id)
             VALUES (?, ?, 0, ?, 'Initial stock', 'product_create', ?, ?)`
          ).run(newId, product.quantity, product.quantity, newId, session.userId);
        }

        db.prepare(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
           VALUES (?, 'product_create', 'product', ?, ?)`
        ).run(session.userId, newId, JSON.stringify(product));

        return newId;
      })();

      return { success: true, productId: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create product';
      const friendly = msg.includes('unique') || msg.includes('UNIQUE') ? 'SKU or barcode already exists' : msg;
      return { success: false, error: friendly };
    }
  });

  // ─── Save Product With Variants (create or update atomically) ─
  // Handles both new product creation and existing product editing.
  // Variants are diffed against the database: new combinations are
  // inserted, existing ones are updated, and combos no longer in the
  // matrix are deactivated.  Everything runs in one SQLite transaction.
  interface VariantInput {
    color: string;
    size: string;
    quantity: number;
    is_active: boolean;
  }

  ipcMain.handle('db:saveProductWithVariants', async (
    _event,
    payload: {
      product: {
        name: string;
        sku: string | null;
        barcode: string | null;
        category_id: number | null;
        brand_id: number | null;
        type: string | null;
        purchase_cost: number;
        selling_price: number;
        min_stock_level: number;
        supplier_id: number | null;
        notes: string | null;
      };
      productId: number | null;
      variants: VariantInput[];
    },
    sessionId?: number,
  ): Promise<{ success: boolean; productId?: number; error?: string }> => {
    try {
      const validation = validateSession(sessionId);
      if (!validation.ok) return { success: false, error: validation.error };

      const isEdit = payload.productId !== null && payload.productId !== undefined;
      const perm = isEdit ? 'products' : 'products.add';
      const permCheck = requirePermission(sessionId!, perm);
      if (!permCheck.ok) return { success: false, error: permCheck.error };

      // Server-side validation
      const p = payload.product;
      if (!p.name || !p.name.trim()) return { success: false, error: 'Product name is required' };
      if (p.selling_price <= 0) return { success: false, error: 'Selling price must be greater than zero' };
      if (p.purchase_cost < 0) return { success: false, error: 'Purchase cost cannot be negative' };

      // Validate variants
      const seen = new Set<string>();
      for (const v of payload.variants) {
        const color = (v.color || '').trim();
        const size = (v.size || '').trim();
        if (!color || !size) return { success: false, error: 'Variant color and size are required' };
        const key = `${color.toLowerCase()}|${size.toLowerCase()}`;
        if (seen.has(key)) return { success: false, error: `Duplicate variant: ${color} / ${size}` };
        seen.add(key);
        if (!Number.isFinite(v.quantity) || v.quantity < 0) return { success: false, error: 'Variant quantities must be non-negative' };
      }

      const session = getSession(sessionId!)!;
      const db = getDb();

      const result = db.transaction(() => {
        let productId: number;

        if (isEdit) {
          productId = payload.productId!;
          db.prepare(
            `UPDATE products SET
              name = ?, sku = ?, barcode = ?, category_id = ?, brand_id = ?,
              type = ?, size = NULL, color = NULL,
              purchase_cost = ?, selling_price = ?,
              min_stock_level = ?, supplier_id = ?, notes = ?,
              updated_at = datetime('now')
            WHERE id = ?`
          ).run(
            p.name.trim(), p.sku || null, p.barcode || null,
            p.category_id || null, p.brand_id || null,
            p.type || null,
            p.purchase_cost, p.selling_price,
            p.min_stock_level, p.supplier_id || null,
            p.notes || null,
            productId,
          );
        } else {
          const info = db.prepare(
            `INSERT INTO products (name, sku, barcode, category_id, brand_id, type, size, color, purchase_cost, selling_price, quantity, min_stock_level, supplier_id, notes)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, ?, ?)`
          ).run(
            p.name.trim(), p.sku || null, p.barcode || null,
            p.category_id || null, p.brand_id || null,
            p.type || null,
            p.purchase_cost, p.selling_price,
            p.min_stock_level, p.supplier_id || null,
            p.notes || null,
          );
          productId = Number(info.lastInsertRowid);
        }

        // ─── Variant sync ──────────────────────────────────
        // Load existing variants for this product
        const existing = db.prepare(
          'SELECT id, color, size, quantity, is_active FROM product_variants WHERE product_id = ?'
        ).all(productId) as Array<{ id: number; color: string; size: string; quantity: number; is_active: number }>;

        // Build lookup of existing variants by lowercase color|size
        const existingMap = new Map<string, { id: number; quantity: number; is_active: number }>();
        for (const e of existing) {
          existingMap.set(`${(e.color || '').toLowerCase()}|${(e.size || '').toLowerCase()}`, { id: e.id, quantity: e.quantity, is_active: e.is_active });
        }

        // Build set of desired variant keys
        const desiredKeys = new Set<string>();
        const insertVariant = db.prepare(
          `INSERT INTO product_variants (product_id, color, size, quantity, is_active)
           VALUES (?, ?, ?, ?, ?)`
        );
        const updateVariant = db.prepare(
          `UPDATE product_variants SET quantity = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`
        );
        const insertMovement = db.prepare(
          `INSERT INTO inventory_movements (product_id, variant_id, quantity_change, previous_quantity, new_quantity, reason, reference_type, reference_id, user_id)
           VALUES (?, ?, ?, 0, ?, 'Initial stock', 'variant_create', NULL, ?)`
        );

        for (const v of payload.variants) {
          const color = v.color.trim();
          const size = v.size.trim();
          const key = `${color.toLowerCase()}|${size.toLowerCase()}`;
          desiredKeys.add(key);

          const ex = existingMap.get(key);
          if (ex) {
            // Update existing variant
            const isActiveInt = v.is_active ? 1 : 0;
            const needsUpdate = ex.quantity !== v.quantity || ex.is_active !== isActiveInt;
            if (needsUpdate) {
              updateVariant.run(v.quantity, isActiveInt, ex.id);
            }
          } else {
            // Insert new variant
            const vInfo = insertVariant.run(productId, color, size, v.quantity, v.is_active ? 1 : 0);
            const variantId = Number(vInfo.lastInsertRowid);
            // Record initial stock movement if quantity > 0
            if (v.quantity > 0) {
              insertMovement.run(productId, variantId, v.quantity, v.quantity, session.userId);
            }
          }
        }

        // Deactivate variants that are no longer in the matrix
        for (const [key, ex] of existingMap) {
          if (!desiredKeys.has(key) && ex.is_active === 1) {
            updateVariant.run(ex.quantity, 0, ex.id);
          }
        }

        // Audit log
        db.prepare(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
           VALUES (?, ?, 'product', ?, ?)`
        ).run(session.userId, isEdit ? 'product_update' : 'product_create', productId, JSON.stringify({ product: p, variants: payload.variants }));

        return productId;
      })();

      return { success: true, productId: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save product';
      const friendly = msg.includes('unique') || msg.includes('UNIQUE') ? 'SKU or barcode already exists' : msg;
      return { success: false, error: friendly };
    }
  });

  // ─── Backup (requires 'backup' permission) ────────────────
  ipcMain.handle('db:backup', async (_event, label?: string, sessionId?: number) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, error: validation.error };
    const check = requirePermission(sessionId!, 'backup');
    if (!check.ok) return { success: false, error: check.error };
    try {
      const backupPath = await createBackup(label);
      return { success: true, path: backupPath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Backup failed' };
    }
  });

  // ─── Restore (requires 'backup' permission) ───────────────
  ipcMain.handle('db:restore', async (_event, backupPath: string, sessionId?: number) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, error: validation.error };
    const check = requirePermission(sessionId!, 'backup');
    if (!check.ok) return { success: false, error: check.error };
    try {
      await restoreFromBackup(backupPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Restore failed' };
    }
  });

  // ─── List Backups (requires 'backup' permission) ──────────
  ipcMain.handle('db:listBackups', async (_event, sessionId?: number) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, error: validation.error, backups: [] };
    const check = requirePermission(sessionId!, 'backup');
    if (!check.ok) return { success: false, error: check.error, backups: [] };
    try {
      return { success: true, backups: listBackups() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to list backups', backups: [] };
    }
  });

  // ─── Delete Backup (requires 'backup' permission) ──────────
  ipcMain.handle('db:deleteBackup', async (_event, backupPath: string, sessionId?: number) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, error: validation.error };
    const check = requirePermission(sessionId!, 'backup');
    if (!check.ok) return { success: false, error: check.error };
    try {
      deleteBackup(backupPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to delete backup' };
    }
  });

  // ─── Save Backup To Custom Location (requires 'backup' permission) ─
  ipcMain.handle('db:saveBackupTo', async (_event, sessionId?: number) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, error: validation.error };
    const check = requirePermission(sessionId!, 'backup');
    if (!check.ok) return { success: false, error: check.error };
    try {
      const saveDialogOptions = {
        title: 'Save Backup As',
        defaultPath: `elakrammen_backup_${new Date().toISOString().slice(0, 10)}.db`,
        filters: [{ name: 'SQLite Database', extensions: ['db'] }, { name: 'All Files', extensions: ['*'] }],
      };
      const parentWindow = getMainWindow();
      const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, saveDialogOptions)
        : await dialog.showSaveDialog(saveDialogOptions);
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }
      const dbPath = getDatabasePath();
      copyFileSync(dbPath, result.filePath);
      return { success: true, path: result.filePath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Export failed' };
    }
  });

  // ─── Get Database Info (requires authentication) ─
  // Exposes database file paths — not for unauthenticated callers.
  ipcMain.handle('db:getInfo', async (_event, sessionId?: number) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, error: validation.error };
    try {
      return { success: true, path: getDatabasePath(), backupDir: getBackupDir() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to get info' };
    }
  });

  // ─── Print (requires valid session) ─────────────────────
  // All authenticated users can print receipts/labels.
  ipcMain.handle('print:print', async (
    _event,
    html: string,
    options: { silent?: boolean; printerName?: string; pageSize?: { width: number; height: number }; margins?: { marginType: 'none' | 'custom'; top?: number; bottom?: number; left?: number; right?: number } } | undefined,
    sessionId?: number,
  ) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, error: validation.error };

    let printWindow: BW | null = null;
    try {
      printWindow = new BW({
        width: 400,
        height: 600,
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      await printWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const printOptions: Electron.PrintToPDFOptions & Electron.WebContentsPrintOptions = {
        silent: options?.silent ?? false,
        printBackground: true,
      };
      if (options?.printerName) (printOptions as Record<string, unknown>).deviceName = options.printerName;
      if (options?.pageSize) (printOptions as Record<string, unknown>).pageSize = options.pageSize;
      if (options?.margins) (printOptions as Record<string, unknown>).margins = options.margins;
      await printWindow.webContents.print(printOptions);
      printWindow.close();
      return { success: true };
    } catch (err) {
      if (printWindow) printWindow.close();
      console.error('[IPC] print:print error:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Print failed' };
    }
  });

  // ─── Get Available Printers (requires valid session) ──────
  ipcMain.handle('print:getPrinters', async (_event, sessionId?: number) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, error: validation.error, printers: [] };
    try {
      const tempWindow = new BW({
        width: 1, height: 1, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      const printers = await tempWindow.webContents.getPrintersAsync();
      tempWindow.close();
      return {
        success: true,
        printers: printers.map((p) => {
          const raw = p as unknown as Record<string, unknown>;
          return {
            name: p.name,
            displayName: p.displayName,
            isDefault: raw.isDefault === true || raw.isDefault === 1,
            status: Number(raw.status) || 0,
          };
        }),
      };
    } catch (err) {
      console.error('[IPC] print:getPrinters error:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to get printers', printers: [] };
    }
  });

  // ─── Get System Info (requires valid session) ─────────────
  ipcMain.handle('system:info', async (_event, sessionId?: number) => {
    const validation = validateSession(sessionId);
    if (!validation.ok) return { success: false, error: validation.error };
    return {
      success: true,
      info: {
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        userInfo: os.userInfo().username,
      },
    };
  });
}
