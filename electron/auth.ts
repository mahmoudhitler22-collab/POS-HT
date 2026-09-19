// Authentication & authorization for the Electron main process.
// Uses Node.js crypto (scrypt) for password hashing — no browser APIs needed.
// Supports transparent migration from legacy PBKDF2 hashes (created by the
// renderer's Web Crypto API before the IPC-based hashing fix).
//
// Security model:
//   - The renderer is NEVER trusted. Every protected IPC call must supply a
//     valid sessionId that was issued by login() or restoreSession().
//   - Sessions are stored in a main-process Map keyed by an opaque integer
//     counter. The renderer cannot forge a session — it only knows the ID
//     we gave it.
//   - restoreSession() only works if the renderer also supplies the
//     *previous* sessionId that is still live in our in-memory map. A bare
//     userId is not enough.
//   - All permission denials are written to audit_logs.

import crypto from 'crypto';
import { getDb } from './database';

const SCRYPT_KEYLEN = 32;

export interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  role_id: number;
  role_name: string;
  is_active: number;
  must_change_password: number;
  permissions: Record<string, boolean>;
  created_at: string;
  updated_at: string;
}

export interface SessionInfo {
  userId: number;
  sessionId: number;       // DB-side session row id (user_sessions.id)
  permissions: Record<string, boolean>;
  role_name: string;
  mustChangePassword: boolean;
}

// ─── In-memory session store ───────────────────────────────
// Key = opaque sessionId issued by login()/restoreSession().
// The renderer only knows this integer; it cannot tamper with the
// permissions or userId stored inside.
const sessions = new Map<number, SessionInfo>();
let sessionCounter = 0;

// ─── Password hashing (scrypt) ──────────────────────────────

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}

function verifyScryptPassword(password: string, hashHex: string, saltHex: string): boolean {
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== SCRYPT_KEYLEN) return false;
    const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(derived, expected);
  } catch { return false; }
}

// PBKDF2 verification — matches the Web Crypto implementation in
// src/lib/crypto.ts (100000 iterations, 32-byte key, SHA-256).
// Used to verify legacy hashes created by the renderer before the
// IPC-based hashing fix. On successful PBKDF2 verification the hash
// is transparently upgraded to scrypt.
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN = 32;

function verifyPbkdf2Password(password: string, hashHex: string, saltHex: string): boolean {
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== PBKDF2_KEYLEN) return false;
    const derived = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, 'sha256');
    return crypto.timingSafeEqual(derived, expected);
  } catch { return false; }
}

export function verifyPassword(password: string, hashHex: string, saltHex: string): boolean {
  if (verifyScryptPassword(password, hashHex, saltHex)) return true;
  return verifyPbkdf2Password(password, hashHex, saltHex);
}



// ─── Owner seeding (first run only) ────────────────────────

const OWNER_PERMISSIONS = JSON.stringify({
  dashboard: true, pos: true, products: true, 'products.add': true,
  'products.view_cost': true, 'products.modify_price': true,
  inventory: true, invoices: true, refunds: true, customers: true,
  expenses: true, reports: true, profit: true, employee_performance: true,
  users: true, settings: true, backup: true, audit: true,
});

export function seedOwnerAccount(): void {
  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  if (count > 0) return;

  const { hash, salt } = hashPassword('Mahmoud79');
  db.prepare(
    `INSERT INTO users (username, password_hash, password_salt, display_name, role_id, must_change_password, permissions)
     VALUES (?, ?, ?, ?, 1, 1, ?)`
  ).run('mahmoud', hash, salt, 'Mahmoud', OWNER_PERMISSIONS);

  console.log('[Auth] Default owner account "mahmoud" created');
}

// ─── Session helpers ───────────────────────────────────────

/**
 * Returns the SessionInfo for a live session, or null if the session
 * does not exist (invalid / expired / never logged in).
 */
export function getSession(sessionId: number | undefined): SessionInfo | null {
  if (sessionId === undefined || sessionId === null) return null;
  return sessions.get(sessionId) ?? null;
}

function createSession(userId: number, dbSessionId: number, perms: Record<string, boolean>, roleName: string, mustChangePassword: boolean): number {
  const sid = ++sessionCounter;
  sessions.set(sid, { userId, sessionId: dbSessionId, permissions: perms, role_name: roleName, mustChangePassword });
  return sid;
}

// ─── Login / logout (main-process side) ─────────────────────

export function login(username: string, password: string): { success: boolean; error?: string; user?: AuthUser; sessionId?: number } {
  const db = getDb();
  const row = db.prepare(
    `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.username = ?`
  ).get(username) as
    | { id: number; username: string; display_name: string; role_id: number; role_name: string; is_active: number; must_change_password: number; password_hash: string; password_salt: string; permissions: string; created_at: string; updated_at: string }
    | undefined;

  if (!row) return { success: false, error: 'User not found' };
  if (row.is_active !== 1) return { success: false, error: 'This account is disabled. Contact the administrator.' };

  if (!verifyPassword(password, row.password_hash, row.password_salt)) {
    return { success: false, error: 'Incorrect password' };
  }

  // Transparent migration: if the stored hash was PBKDF2 (created by the
  // renderer's Web Crypto API before the IPC hashing fix), re-hash with
  // scrypt now so all future logins use the main-process algorithm.
  if (!verifyScryptPassword(password, row.password_hash, row.password_salt)) {
    const { hash: newHash, salt: newSalt } = hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(newHash, newSalt, row.id);
    console.log(`[Auth] Migrated password hash to scrypt for user "${row.username}"`);
  }

  const perms = applyRolePermissionFixes(parsePermissionsJson(row.permissions), row.role_name);

  const sessionRes = db.prepare('INSERT INTO user_sessions (user_id) VALUES (?) RETURNING id').get(row.id) as { id: number };
  const sid = createSession(row.id, sessionRes.id, perms, row.role_name, row.must_change_password === 1);

  const user: AuthUser = {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role_id: row.role_id,
    role_name: row.role_name,
    is_active: row.is_active,
    must_change_password: row.must_change_password,
    permissions: perms,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  return { success: true, user, sessionId: sid };
}

export function logout(sessionId: number): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  const db = getDb();
  db.prepare("UPDATE user_sessions SET logout_at = datetime('now') WHERE id = ?").run(s.sessionId);
  sessions.delete(sessionId);
}

export function changeInitialPassword(sessionId: number, password: string): { success: boolean; error?: string } {
  const session = sessions.get(sessionId);
  if (!session) return { success: false, error: 'Not authenticated. Please log in again.' };
  if (!session.mustChangePassword) return { success: false, error: 'A password change is not required for this session.' };
  if (typeof password !== 'string' || password.length < 10) {
    return { success: false, error: 'Password must contain at least 10 characters.' };
  }

  const { hash, salt } = hashPassword(password);
  getDb().prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?"
  ).run(hash, salt, session.userId);
  session.mustChangePassword = false;
  return { success: true };
}

/**
 * Restore a session after a page reload. The renderer must supply the
 * *previous* sessionId that is still live in our in-memory map. A bare
 * userId is NOT accepted — this prevents session spoofing.
 */
export function restoreSession(previousSessionId: number): { success: boolean; sessionId?: number; user?: AuthUser } {
  // The old session must still be in our map — proves it was issued by us.
  const oldSession = sessions.get(previousSessionId);
  if (!oldSession) return { success: false };

  // Re-read the user to make sure they're still active.
  const db = getDb();
  const row = db.prepare(
    `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ? AND u.is_active = 1`
  ).get(oldSession.userId) as
    | { id: number; username: string; display_name: string; role_id: number; role_name: string; is_active: number; must_change_password: number; permissions: string; created_at: string; updated_at: string }
    | undefined;

  if (!row) return { success: false };

  const perms = applyRolePermissionFixes(parsePermissionsJson(row.permissions), row.role_name);
  const sessionRes = db.prepare('INSERT INTO user_sessions (user_id) VALUES (?) RETURNING id').get(row.id) as { id: number };
  const sid = createSession(row.id, sessionRes.id, perms, row.role_name, row.must_change_password === 1);

  const user: AuthUser = {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role_id: row.role_id,
    role_name: row.role_name,
    is_active: row.is_active,
    must_change_password: row.must_change_password,
    permissions: perms,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  return { success: true, sessionId: sid, user };
}

// ─── Permission checking ────────────────────────────────────

export function hasPermission(sessionId: number, perm: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  return !!s.permissions[perm];
}

export function requirePermission(sessionId: number, perm: string): { ok: boolean; error?: string } {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false, error: 'Not authenticated' };
  if (!s.permissions[perm]) {
    logUnauthorized(sessionId, perm);
    return { ok: false, error: `Permission denied: ${perm}` };
  }
  return { ok: true };
}

function logUnauthorized(sessionId: number, perm: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO audit_logs (user_id, action, entity_type, new_value) VALUES (?, 'unauthorized_access', 'permission', ?)`
    ).run(s.userId, `Denied: ${perm}`);
  } catch { /* best-effort */ }
}

function parsePermissionsJson(json: string): Record<string, boolean> {
  try { return JSON.parse(json); } catch { return {}; }
}

// Early installations stored an explicit permission snapshot with every user.
// Keep existing manager accounts aligned with the documented system role after
// refunds were added to that role, without changing any other custom grants.
function applyRolePermissionFixes(perms: Record<string, boolean>, roleName: string): Record<string, boolean> {
  if (roleName === 'manager') return { ...perms, refunds: true };
  if (roleName === 'cashier' || roleName === 'inventory') return { ...perms, customers: true };
  return perms;
}

// ─── SQL-based permission classification ──────────────────
// Maps a SQL statement to the permission required to execute it.

type SqlOp = 'select' | 'insert' | 'update' | 'delete';

// Strips the CTE prefix from a WITH ... statement, returning the main
// DML statement (SELECT / INSERT / UPDATE / DELETE) that follows the
// CTE definitions. Handles WITH RECURSIVE and multiple CTEs.
function stripCtePrefix(sql: string): string {
  let i = 0;
  const len = sql.length;

  // Skip "WITH"
  i += 4;

  // Skip whitespace
  while (i < len && /\s/.test(sql[i])) i++;

  // Skip optional RECURSIVE
  if (sql.substring(i, i + 9).toUpperCase() === 'RECURSIVE') {
    i += 9;
  }

  // Skip each CTE definition: name AS (subquery), ...
  while (i < len) {
    while (i < len && /\s/.test(sql[i])) i++;

    // Skip CTE name (identifier, possibly double-quoted)
    if (sql[i] === '"') {
      i++;
      while (i < len && sql[i] !== '"') i++;
      if (i < len) i++;
    } else {
      while (i < len && /[A-Za-z0-9_]/.test(sql[i])) i++;
    }

    while (i < len && /\s/.test(sql[i])) i++;

    // Expect "AS"
    if (i + 2 <= len && sql.substring(i, i + 2).toUpperCase() === 'AS') {
      i += 2;
    } else {
      break;
    }

    while (i < len && /\s/.test(sql[i])) i++;

    // Skip parenthesized subquery
    if (i < len && sql[i] === '(') {
      let depth = 1;
      i++;
      while (i < len && depth > 0) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')') depth--;
        i++;
      }
    } else {
      break;
    }

    while (i < len && /\s/.test(sql[i])) i++;

    // Comma → another CTE follows
    if (i < len && sql[i] === ',') {
      i++;
      continue;
    }
    break;
  }

  return sql.substring(i).trim();
}

// Returns true if the SQL statement is a read-only SELECT (including
// CTE-wrapped SELECTs). Used by IPC handlers to choose stmt.all() vs
// stmt.run().
export function isSelectSql(sql: string): boolean {
  let trimmed = sql.trim().replace(/^\s+/i, '');
  let upper = trimmed.toUpperCase();
  if (upper.startsWith('WITH')) {
    trimmed = stripCtePrefix(trimmed);
    upper = trimmed.toUpperCase();
  }
  return upper.startsWith('SELECT');
}

// Maps table+op to required permission.
// null = any authenticated user can perform this op on this table.
const TABLE_PERMISSIONS: Record<string, {
  select?: string | null;
  insert?: string | null;
  update?: string | null;
  delete?: string | null;
}> = {
  products: {
    select: null,
    insert: 'products.add',
    update: 'products',
    delete: 'products',
  },
  product_variants: {
    select: null,
    insert: 'products.add',
    update: 'products',
    delete: 'products',
  },
  categories: {
    select: null,
    insert: 'products',
    update: 'products',
    delete: 'products',
  },
  brands: {
    select: null,
    insert: 'products',
    update: 'products',
    delete: 'products',
  },
  suppliers: {
    select: null,
    insert: 'products',
    update: 'products',
    delete: 'products',
  },
  sales: {
    select: 'pos',
    // Sales are immutable from the renderer.  Creating one is done only by
    // the validated sales:complete IPC handler; this prevents a POS session
    // from deleting or rewriting accounting records through generic SQL.
    insert: 'sales.manage',
    update: 'sales.manage',
    delete: 'sales.manage',
  },
  sale_items: {
    select: 'pos',
    insert: 'sales.manage',
    update: 'sales.manage',
    delete: 'sales.manage',
  },
  payments: {
    select: 'pos',
    insert: 'sales.manage',
    update: 'sales.manage',
    delete: 'sales.manage',
  },
  refunds: {
    select: 'refunds',
    insert: 'refunds.manage',
    update: 'refunds.manage',
    delete: 'refunds.manage',
  },
  refund_items: {
    select: 'refunds',
    insert: 'refunds.manage',
    update: 'refunds.manage',
    delete: 'refunds.manage',
  },
  expenses: {
    select: 'expenses',
    insert: 'expenses',
    update: 'expenses',
    delete: 'expenses',
  },
  inventory_movements: {
    select: 'inventory',
    insert: 'inventory',
    update: 'inventory',
    delete: 'inventory',
  },
  customers: {
    select: 'customers',
    insert: 'customers',
    update: 'customers',
    delete: 'customers',
  },
  loyalty_transactions: {
    select: 'customers',
    insert: 'customers',
    update: 'customers',
    delete: 'customers',
  },
  users: {
    select: 'users',
    insert: 'users',
    update: 'users',
    delete: 'users',
  },
  public_users: {
    select: null,
  },
  roles: {
    select: 'users',
    insert: 'users',
    update: 'users',
    delete: 'users',
  },
  settings: {
    select: null,
    insert: 'settings',
    update: 'settings',
    delete: 'settings',
  },
  audit_logs: {
    select: 'audit',
    insert: 'audit',
    update: 'audit',
    delete: 'audit',
  },
  barcode_labels: {
    select: 'products',
    insert: 'products',
    update: 'products',
    delete: 'products',
  },
};

// Columns that reveal cost/profit information. If any of these appear
// in a SELECT or are written in an INSERT/UPDATE, extra permission
// checks apply.
const COST_COLUMNS = ['PURCHASE_COST', 'COST_AT_SALE', 'COST_OF_GOODS', 'GROSS_PROFIT', 'NET_PROFIT'];

/**
 * Check whether a SQL statement touches cost/profit columns.
 * - SELECT: requires 'products.view_cost' (for purchase_cost on products)
 *   OR 'profit' (for cost_at_sale, gross_profit, net_profit on sales/reports).
 * - INSERT/UPDATE: writing cost columns requires 'products' or 'profit'
 *   depending on the column.
 */
function checkSqlForCostData(sessionId: number, sql: string, op: SqlOp): { ok: boolean; error?: string } {
  const upper = sql.toUpperCase();
  const hasCostCol = COST_COLUMNS.some((c) => upper.includes(c));
  const selectedColumns = op === 'select' ? upper.match(/\bSELECT\s+([\s\S]*?)\s+\bFROM\b/)?.[1] ?? '' : '';
  const selectsAllColumns = /(^|,)\s*(?:[A-Z_][A-Z0-9_]*\.)?\*\s*(,|$)/.test(selectedColumns);
  const accessesProductCost = selectsAllColumns && /\b(?:FROM|JOIN)\s+(?:PRODUCTS|PRODUCT_VARIANTS)\b/.test(upper);
  const accessesSaleCost = selectsAllColumns && /\b(?:FROM|JOIN)\s+SALE_ITEMS\b/.test(upper);
  if (!hasCostCol && !accessesProductCost && !accessesSaleCost) return { ok: true };

  if (op === 'select') {
    // purchase_cost on products table → products.view_cost
    // cost_at_sale / gross_profit / net_profit → profit
    if (accessesSaleCost || upper.includes('COST_AT_SALE') || upper.includes('GROSS_PROFIT') || upper.includes('NET_PROFIT') || upper.includes('COST_OF_GOODS')) {
      return requirePermission(sessionId, 'profit');
    }
    if (accessesProductCost || upper.includes('PURCHASE_COST')) {
      return requirePermission(sessionId, 'products.view_cost');
    }
    return { ok: true };
  }

  // For INSERT/UPDATE on cost columns:
  //   - INSERT with purchase_cost → products.add (adding a product includes setting its cost)
  //   - UPDATE with purchase_cost → products (editing cost is general product management)
  //   - UPDATE with purchase_cost by someone who can't view_cost → still blocked
  //     because the table-level 'products' permission for UPDATE is checked first
  //   - cost_at_sale / cost_of_goods → profit (these are financial reporting columns)
  if (op === 'insert') {
    if (upper.includes('PURCHASE_COST')) {
      return requirePermission(sessionId, 'products.add');
    }
    if (upper.includes('COST_AT_SALE') || upper.includes('COST_OF_GOODS')) {
      return requirePermission(sessionId, 'profit');
    }
  }

  if (op === 'update') {
    if (upper.includes('PURCHASE_COST')) {
      return requirePermission(sessionId, 'products');
    }
    if (upper.includes('COST_AT_SALE') || upper.includes('COST_OF_GOODS')) {
      return requirePermission(sessionId, 'profit');
    }
  }

  return { ok: true };
}

export function checkSqlPermission(sessionId: number, sql: string): { ok: boolean; error?: string } {
  // The renderer is untrusted.  Looking at only the first table in a query is
  // not sufficient: `SELECT ... FROM products JOIN users ...` would otherwise
  // inherit the public products permission and expose the users table.
  // Keep this bridge deliberately limited to the SQL shape used by the app.
  // New data access should prefer a dedicated IPC handler.
  const normalized = sql.trim();
  if (!normalized || /;|--|\/\*|\*\/|"|`|\[|\]/.test(normalized)) {
    return { ok: false, error: 'Permission denied: unsupported SQL syntax' };
  }

  const tableAccesses = collectTableAccesses(normalized);
  if (tableAccesses.length === 0) {
    return { ok: false, error: 'Permission denied: unrecognized or unsupported SQL statement' };
  }

  // Product and user removal must go through their dedicated IPC handlers.
  // Those handlers keep the audit trail and prevent deleting records that are
  // needed by sales, refunds, inventory history, or the primary owner account.
  if (tableAccesses.some(({ table, op }) => op === 'delete' && (table === 'products' || table === 'users'))) {
    return { ok: false, error: 'Permission denied: use the dedicated deletion operation' };
  }

  for (const { table, op } of tableAccesses) {
    const tableConfig = TABLE_PERMISSIONS[table];
    if (!tableConfig) {
      return { ok: false, error: `Permission denied: access to table '${table}' is restricted` };
    }

    const requiredPerm = tableConfig[op];
    if (requiredPerm !== null && requiredPerm !== undefined) {
      const permResult = requirePermission(sessionId, requiredPerm);
      if (!permResult.ok) return permResult;
    }

    const costCheck = checkSqlForCostData(sessionId, normalized, op);
    if (!costCheck.ok) return costCheck;
  }

  return { ok: true };
}

/**
 * Extract every table operation from the constrained SQL accepted by the IPC
 * bridge.  A statement may read several tables, or write one table while
 * selecting from another, so permissions are evaluated for each occurrence.
 */
function collectTableAccesses(sql: string): Array<{ table: string; op: SqlOp }> {
  const accesses = new Map<string, Set<SqlOp>>();
  const add = (table: string, op: SqlOp) => {
    const normalizedTable = table.toLowerCase();
    const operations = accesses.get(normalizedTable) ?? new Set<SqlOp>();
    operations.add(op);
    accesses.set(normalizedTable, operations);
  };

  const patterns: Array<{ pattern: RegExp; op: SqlOp }> = [
    { pattern: /\bINSERT(?:\s+OR\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK))?\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/gi, op: 'insert' },
    // `ON CONFLICT (...) DO UPDATE SET ...` is part of an INSERT upsert,
    // not a second UPDATE statement against a table named "SET".
    { pattern: /\bUPDATE\s+(?!SET\b)([A-Za-z_][A-Za-z0-9_]*)/gi, op: 'update' },
    { pattern: /\bDELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi, op: 'delete' },
    { pattern: /\bJOIN\s+([A-Za-z_][A-Za-z0-9_]*)/gi, op: 'select' },
  ];

  for (const { pattern, op } of patterns) {
    for (const match of sql.matchAll(pattern)) add(match[1], op);
  }

  // A FROM clause may list more than one table (`FROM settings, users`).
  // Inspect each comma-separated source rather than only the first one.
  const fromClause = /\bFROM\s+([\s\S]*?)(?=\b(?:WHERE|GROUP|ORDER|HAVING|LIMIT|UNION|LEFT|RIGHT|INNER|FULL|CROSS|JOIN|ON)\b|$)/gi;
  for (const match of sql.matchAll(fromClause)) {
    for (const source of match[1].split(',')) {
      const table = source.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      if (table) add(table, 'select');
    }
  }

  return [...accesses].flatMap(([table, operations]) =>
    [...operations].map((op) => ({ table, op })),
  );
}
