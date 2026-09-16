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

export async function restoreFromBackup(backupPath: string): Promise<void> {
  const verifiedBackupPath = getManagedBackupPath(backupPath);

  // Close current database
  if (db) {
    db.close();
    db = null;
  }

  const dbPath = getDatabasePath();

  // Create a safety backup before restore
  if (fs.existsSync(dbPath)) {
    const safetyPath = dbPath + '.pre_restore';
    fs.copyFileSync(dbPath, safetyPath);
  }

  // Copy backup file to database location
  fs.copyFileSync(verifiedBackupPath, dbPath);

  // Reopen
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Run migrations on restored data
  await runMigrations();

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
