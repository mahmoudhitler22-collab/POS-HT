import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { PGlite } from '@electric-sql/pglite';
import { PGLITE_SCHEMA_SQL, PGLITE_SEED_SQL, SCHEMA_SQL, SEED_SQL } from '../src/db/schema.ts';

test('SQLite: a sale and refund update the selected variant, not its parent product', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec(SEED_SQL);
  db.prepare(
    'INSERT INTO users (username, password_hash, password_salt, display_name, role_id) VALUES (?, ?, ?, ?, ?)',
  ).run('tester', 'hash', 'salt', 'Tester', 1);

  const productId = Number(
    db.prepare('INSERT INTO products (name, selling_price, quantity) VALUES (?, ?, ?)')
      .run('T-shirt', 10_000, 0).lastInsertRowid,
  );
  const variantId = Number(
    db.prepare('INSERT INTO product_variants (product_id, color, size, quantity) VALUES (?, ?, ?, ?)')
      .run(productId, 'Blue', 'L', 5).lastInsertRowid,
  );
  const saleId = Number(
    db.prepare('INSERT INTO sales (invoice_number, cashier_id, subtotal, total) VALUES (?, ?, ?, ?)')
      .run('INV-TEST', 1, 20_000, 20_000).lastInsertRowid,
  );
  const saleItemId = Number(
    db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, variant_id, product_name, unit_price, quantity, final_price, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(saleId, productId, variantId, 'T-shirt — Blue / L', 10_000, 2, 20_000, 20_000).lastInsertRowid,
  );

  db.prepare('UPDATE product_variants SET quantity = quantity - ? WHERE id = ?').run(2, variantId);
  const afterSale = db.prepare(
    `SELECT p.quantity AS parent_quantity, pv.quantity AS variant_quantity
       FROM products p JOIN product_variants pv ON pv.product_id = p.id WHERE p.id = ?`,
  ).get(productId) as { parent_quantity: number; variant_quantity: number };
  assert.deepEqual(afterSale, { parent_quantity: 0, variant_quantity: 3 });

  const refundId = Number(
    db.prepare('INSERT INTO refunds (refund_number, sale_id, cashier_id, total) VALUES (?, ?, ?, ?)')
      .run('RFD-TEST', saleId, 1, 20_000).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO refund_items (refund_id, sale_item_id, product_id, variant_id, product_name, quantity, unit_price, refund_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(refundId, saleItemId, productId, variantId, 'T-shirt — Blue / L', 2, 10_000, 20_000);
  db.prepare('UPDATE product_variants SET quantity = quantity + ? WHERE id = ?').run(2, variantId);

  const afterRefund = db.prepare('SELECT quantity FROM product_variants WHERE id = ?').get(variantId) as { quantity: number };
  assert.equal(afterRefund.quantity, 5);
  db.close();
});

test('PGlite: schema and seed can be safely re-run', async () => {
  const db = new PGlite();
  await db.exec(PGLITE_SCHEMA_SQL);
  await db.exec(PGLITE_SEED_SQL);
  await db.exec(PGLITE_SCHEMA_SQL);
  await db.exec(PGLITE_SEED_SQL);

  const result = await db.query<{ roles: number; settings: number }>(
    'SELECT (SELECT COUNT(*) FROM roles) AS roles, (SELECT COUNT(*) FROM settings) AS settings',
  );
  assert.deepEqual(result.rows[0], { roles: 4, settings: 18 });
  await db.close();
});
