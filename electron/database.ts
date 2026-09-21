import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { SCHEMA_SQL, SEED_SQL, SCHEMA_VERSION } from '../src/db/schema';
import { seedOwnerAccount } from './auth';

let db: Database.Database | null = null;

export function getDatabasePath(): string {
  return path.join(app.getPath('userData'), 'elakrammen_pos.db');
}

export function getBackupDir(): string {
  const backupDir = path.join(app.getPath('userData'), 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  return backupDir;
}

/** Return a verified database file that belongs to the application's backup directory. */
function getManagedBackupPath(backupPath: string): string {
  const backupDir = fs.realpathSync(getBackupDir());
  const resolvedPath = fs.realpathSync(backupPath);
  const relativePath = path.relative(backupDir, resolvedPath);
  const isInsideBackupDir = relativePath !== '' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);

  if (!isInsideBackupDir || path.extname(resolvedPath).toLowerCase() !== '.db') {
    throw new Error('Invalid backup path');
  }
  return resolvedPath;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export async function initDatabase(): Promise<void> {
  const dbPath = getDatabasePath();
  console.log(`[Database] Initializing SQLite at: ${dbPath}`);

  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    await runMigrations();
  } catch (err) {
    console.error('[Database] Initialization failed:', err);
    if (db) {
      try { db.close(); } catch { /* best-effort */ }
      db = null;
    }
    throw new Error(
      `Database initialization failed: ${err instanceof Error ? err.message : String(err)}. ` +
      `Database path: ${dbPath}`
    );
  }
}

function columnExists(table: string, column: string): boolean {
  if (!db) throw new Error('Database not initialized');
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function applyIncrementalMigrations(currentVersion: number): void {
  if (!db || currentVersion >= SCHEMA_VERSION) return;

  if (currentVersion < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        login_at TEXT NOT NULL DEFAULT (datetime('now')),
        logout_at TEXT
      );
      CREATE TABLE IF NOT EXISTS product_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        size TEXT, color TEXT, barcode TEXT UNIQUE,
        purchase_cost INTEGER, selling_price INTEGER,
        quantity REAL NOT NULL DEFAULT 0,
        min_stock_level REAL NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id),
        sale_id INTEGER,
        refund_id INTEGER,
        points INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    if (!columnExists('sale_items', 'variant_id')) db.exec('ALTER TABLE sale_items ADD COLUMN variant_id INTEGER REFERENCES product_variants(id)');
    if (!columnExists('refund_items', 'variant_id')) db.exec('ALTER TABLE refund_items ADD COLUMN variant_id INTEGER REFERENCES product_variants(id)');
    if (!columnExists('inventory_movements', 'variant_id')) db.exec('ALTER TABLE inventory_movements ADD COLUMN variant_id INTEGER REFERENCES product_variants(id)');
    if (!columnExists('barcode_labels', 'variant_id')) db.exec('ALTER TABLE barcode_labels ADD COLUMN variant_id INTEGER REFERENCES product_variants(id)');
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('loyalty_points_per_1000_egp', '10')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('max_discount_percentage', '20')").run();
  }

  if (currentVersion < 4 && !columnExists('users', 'must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }

  if (currentVersion < 5) {
    migrateVariantsToProducts(db);
  }
}

// ─── v5: Flatten product_variants into standalone products ────
// Each variant becomes its own products row with model_name copied
// from the parent's name.  sale_items, refund_items,
// inventory_movements, and barcode_labels are remapped so old
// records point to the new product_id (variant_id is set to NULL).
function migrateVariantsToProducts(database: Database.Database): void {
  if (!columnExists('products', 'model_name')) {
    database.exec('ALTER TABLE products ADD COLUMN model_name TEXT NOT NULL DEFAULT \'\'');
  }

  // Already migrated (no product_variants table or it's empty)
  if (!tableExists('product_variants')) return;
  const variantCount = database.prepare('SELECT COUNT(*) AS count FROM product_variants').get() as { count: number };
  if (variantCount.count === 0) return;

  // Set model_name = name for all existing products
  database.exec("UPDATE products SET model_name = name WHERE model_name = '' OR model_name IS NULL");

  // For each product with variants, create one new product per variant
  const variants = database.prepare(
    `SELECT pv.id AS variant_id, pv.product_id, pv.color, pv.size, pv.barcode,
            pv.purchase_cost, pv.selling_price, pv.quantity, pv.min_stock_level,
            p.name AS parent_name, p.model_name, p.brand_id, p.category_id,
            p.type, p.supplier_id, p.notes, p.is_active
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id`
  ).all() as Array<{
    variant_id: number; product_id: number; color: string | null; size: string | null;
    barcode: string | null; purchase_cost: number | null; selling_price: number | null;
    quantity: number; min_stock_level: number; parent_name: string; model_name: string;
    brand_id: number | null; category_id: number | null; type: string | null;
    supplier_id: number | null; notes: string | null; is_active: number;
  }>;

  const insertProduct = database.prepare(
    `INSERT INTO products (name, model_name, sku, barcode, brand_id, category_id, type, size, color,
       purchase_cost, selling_price, quantity, min_stock_level, supplier_id, notes, is_active)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const v of variants) {
    const color = v.color || '';
    const size = v.size || '';
    const parts = [v.model_name, color, size].filter(Boolean);
    const newName = parts.join(' - ');
    const cost = v.purchase_cost ?? 0;
    const price = v.selling_price ?? 0;

    const info = insertProduct.run(
      newName, v.model_name, v.barcode, v.brand_id, v.category_id, v.type,
      v.size, v.color, cost, price, v.quantity, v.min_stock_level,
      v.supplier_id, v.notes, v.is_active,
    );
    const newProductId = Number(info.lastInsertRowid);

    // Remap sale_items
    database.prepare('UPDATE sale_items SET product_id = ?, variant_id = NULL WHERE variant_id = ?')
      .run(newProductId, v.variant_id);
    // Remap refund_items
    database.prepare('UPDATE refund_items SET product_id = ?, variant_id = NULL WHERE variant_id = ?')
      .run(newProductId, v.variant_id);
    // Remap inventory_movements
    database.prepare('UPDATE inventory_movements SET product_id = ?, variant_id = NULL WHERE variant_id = ?')
      .run(newProductId, v.variant_id);
    // Remap barcode_labels
    database.prepare('UPDATE barcode_labels SET product_id = ?, variant_id = NULL WHERE variant_id = ?')
      .run(newProductId, v.variant_id);
  }

  // Deactivate old parent products that had variants
  const parentIds = [...new Set(variants.map((v) => v.product_id))];
  const placeholders = parentIds.map(() => '?').join(',');
  database.prepare(`UPDATE products SET is_active = 0 WHERE id IN (${placeholders})`).run(...parentIds);

  console.log(`[Database] Migrated ${variants.length} variants to standalone products, deactivated ${parentIds.length} parent products`);
}

function tableExists(tableName: string): boolean {
  if (!db) throw new Error('Database not initialized');
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName) as { name: string } | undefined;
  return !!row;
}

function getSchemaVersion(): number {
  if (!db) throw new Error('Database not initialized');
  if (!tableExists('schema_meta')) return -1;
  const meta = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version') as { value: string } | undefined;
  return meta ? parseInt(meta.value, 10) : 0;
}

function setSchemaVersion(version: number): void {
  if (!db) throw new Error('Database not initialized');
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(version));
}

async function runMigrations(): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  const currentVersion = getSchemaVersion();

  if (currentVersion === -1) {
    // No schema_meta table → either a fresh database or an old database
    // that predates the migration system.
    const hasTables = tableExists('users');
    if (!hasTables) {
      // Fresh database — apply schema + seed directly
      db.exec(SCHEMA_SQL);
      db.exec(SEED_SQL);
      seedOwnerAccount();
      console.log('[Database] Fresh database created with schema version', SCHEMA_VERSION);
    } else {
      // Existing database without migration metadata — bootstrap it.
      // Run SCHEMA_SQL (all statements are IF NOT EXISTS so existing
      // tables/columns are preserved), then record the current version.
      db.exec(SCHEMA_SQL);
      db.exec(SEED_SQL);
      applyIncrementalMigrations(0);
      seedOwnerAccount();
      setSchemaVersion(SCHEMA_VERSION);
      console.log('[Database] Bootstrapped migration metadata on existing database at version', SCHEMA_VERSION);
    }
  } else if (currentVersion === 0) {
    // Version 0 — fresh schema_meta but no actual schema yet
    db.exec(SCHEMA_SQL);
    db.exec(SEED_SQL);
    seedOwnerAccount();
    console.log('[Database] Fresh database created with schema version', SCHEMA_VERSION);
  } else if (currentVersion < SCHEMA_VERSION) {
    // Existing database needs migration — backup first
    console.log(`[Database] Migrating from version ${currentVersion} to ${SCHEMA_VERSION}`);
    await createBackup(`pre_migration_v${currentVersion}_to_v${SCHEMA_VERSION}`);

    applyIncrementalMigrations(currentVersion);
    db.exec(SCHEMA_SQL);
    db.exec(SEED_SQL);
    seedOwnerAccount();
    setSchemaVersion(SCHEMA_VERSION);
    console.log('[Database] Migration complete');
  } else {
    // Up to date — ensure all tables exist (safe with IF NOT EXISTS)
    db.exec(SCHEMA_SQL);
    db.exec(SEED_SQL);
    seedOwnerAccount();
  }
}

export async function createBackup(label?: string): Promise<string> {
  const backupDir = getBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = label?.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  const backupName = safeLabel ? `backup_${safeLabel}_${timestamp}.db` : `backup_${timestamp}.db`;
  const backupPath = path.join(backupDir, backupName);

  // Use SQLite backup API for a safe, consistent copy.
  // db.backup() returns a promise that resolves when the backup is complete.
  // We must await it before returning the path to guarantee the file is valid.
  if (!db) throw new Error('Database not initialized');
  await db.backup(backupPath);

  console.log(`[Database] Backup created: ${backupPath}`);
  return backupPath;
}

export async function backupTo(destinationPath: string): Promise<void> {
  if (!db) throw new Error('Database not initialized');
  await db.backup(destinationPath);
}

export async function restoreFromBackup(backupPath: string): Promise<void> {
  const verifiedBackupPath = getManagedBackupPath(backupPath);
  const dbPath = getDatabasePath();
  const safetyPath = dbPath + '.pre_restore';

  // Capture a consistent pre-restore snapshot before closing the WAL database.
  if (db) {
    await db.backup(safetyPath);
    db.close();
    db = null;
  } else if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, safetyPath);
  }

  try {
    fs.copyFileSync(verifiedBackupPath, dbPath);
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    await runMigrations();
  } catch (err) {
    if (db) {
      try { db.close(); } catch { /* best-effort */ }
      db = null;
    }
    if (fs.existsSync(safetyPath)) {
      fs.copyFileSync(safetyPath, dbPath);
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
    }
    throw new Error(`Restore failed; the previous database was restored. ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log('[Database] Restore complete');
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function listBackups(): { name: string; path: string; size: number; date: string }[] {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return [];

  return fs.readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.db'))
    .map((entry) => {
      const fullPath = path.join(backupDir, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        size: stat.size,
        date: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function deleteBackup(backupPath: string): void {
  fs.unlinkSync(getManagedBackupPath(backupPath));
}
