import { useState, useEffect, useCallback, useMemo } from 'react';
import { query, execute, transaction, isRunningInElectron, getAuthSessionId, deleteProduct } from '@/db/client';
import { useAuth } from '@/context/AuthContext';
import { logAudit } from '@/lib/audit';
import { formatEgp, formatQuantity, parseLocalizedNumber, toPiasters } from '@/lib/money';
import { arabicSearchPattern, normalizeArabicSearch, normalizeArabicSql } from '@/lib/search';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import type { Product, ProductVariant, Category, Brand, Supplier } from '@/types';
import { Plus, Search, Pencil, Archive, RotateCcw, Package, Barcode, TriangleAlert as AlertTriangle, X, Tag, Folder, Truck, Printer, Loader as Loader2, Grid3x3, Palette, Ruler, Trash2 } from 'lucide-react';
import { useSettings } from '@/context/SettingsContext';
import { useLanguage } from '@/context/LanguageContext';
import { generateLabelHtml, printHtml, getPrinters, type PrinterInfo } from '@/lib/print';

type Tab = 'products' | 'categories' | 'brands' | 'suppliers';

export function ProductsPage() {
  const { user, hasPermission } = useAuth();
  const [tab, setTab] = useState<Tab>('products');
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterSize, setFilterSize] = useState('');
  const [filterColor, setFilterColor] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [labelTarget, setLabelTarget] = useState<Product | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  const loadData = useCallback(async () => {
    const [cats, brnds, sups] = await Promise.all([
      query<Category>('SELECT * FROM categories ORDER BY name'),
      query<Brand>('SELECT * FROM brands ORDER BY name'),
      query<Supplier>('SELECT * FROM suppliers ORDER BY name'),
    ]);
    setCategories(cats.rows);
    setBrands(brnds.rows);
    setSuppliers(sups.rows);
  }, []);

  const loadProducts = useCallback(async () => {
    const canViewCost = hasPermission('products.view_cost');
    const costColumn = canViewCost ? 'p.purchase_cost,' : '';
    let sql = `
      SELECT p.id, p.name, p.sku, p.barcode, p.category_id, p.brand_id,
             p.type, p.size, p.color, ${costColumn} p.selling_price,
             p.quantity, p.min_stock_level, p.supplier_id, p.is_active,
             p.notes, p.created_at, p.updated_at,
             c.name as category_name, b.name as brand_name,
             COALESCE((
               SELECT SUM(pv.quantity) FROM product_variants pv
               WHERE pv.product_id = p.id AND pv.is_active = 1
             ), NULL) as variant_total_stock
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN brands b ON p.brand_id = b.id
      WHERE 1=1
    `;
    const params: unknown[] = [];
    let paramIdx = 1;

    if (!showArchived) {
      sql += ` AND p.is_active = 1`;
    }

    if (search.trim()) {
      sql += ` AND (${normalizeArabicSql('p.name')} LIKE ${paramIdx} OR ${normalizeArabicSql('p.sku')} LIKE ${paramIdx} OR ${normalizeArabicSql('p.barcode')} LIKE ${paramIdx} OR ${normalizeArabicSql('p.color')} LIKE ${paramIdx} OR ${normalizeArabicSql('p.size')} LIKE ${paramIdx})`;
      params.push(arabicSearchPattern(search));
      paramIdx++;
    }
    if (filterCategory) {
      sql += ` AND p.category_id = $${paramIdx}`;
      params.push(parseInt(filterCategory, 10));
      paramIdx++;
    }
    if (filterBrand) {
      sql += ` AND p.brand_id = $${paramIdx}`;
      params.push(parseInt(filterBrand, 10));
      paramIdx++;
    }
    if (filterSize) {
      sql += ` AND ${normalizeArabicSql('p.size')} = $${paramIdx}`;
      params.push(normalizeArabicSearch(filterSize));
      paramIdx++;
    }
    if (filterColor) {
      sql += ` AND ${normalizeArabicSql('p.color')} LIKE $${paramIdx}`;
      params.push(arabicSearchPattern(filterColor));
      paramIdx++;
    }

    sql += ` ORDER BY p.name LIMIT 500`;
    const res = await query<Product>(sql, params);
    setProducts(res.rows);
  }, [search, filterCategory, filterBrand, filterSize, filterColor, showArchived, hasPermission]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { loadProducts(); }, [loadProducts]);

  const handleArchive = async (product: Product) => {
    await execute('UPDATE products SET is_active = 0, updated_at = datetime(\'now\') WHERE id = $1', [product.id]);
    await logAudit({
      user_id: user?.id ?? null,
      action: 'product_archive',
      entity_type: 'product',
      entity_id: product.id,
      new_value: 'archived',
    });
    toast('success', `Product "${product.name}" archived`);
    setArchiveTarget(null);
    loadProducts();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteProduct(deleteTarget.id);
      toast('success', `Product "${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
      loadProducts();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to delete product');
    }
  };

  const handleRestore = async (product: Product) => {
    await execute('UPDATE products SET is_active = 1, updated_at = datetime(\'now\') WHERE id = $1', [product.id]);
    await logAudit({
      user_id: user?.id ?? null,
      action: 'product_restore',
      entity_type: 'product',
      entity_id: product.id,
      new_value: 'active',
    });
    toast('success', `Product "${product.name}" restored`);
    loadProducts();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Products</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage your product catalog, categories, brands, and suppliers</p>
        </div>
        {tab === 'products' && (hasPermission('products') || hasPermission('products.add')) && (
          <Button onClick={() => { setEditingProduct(null); setShowAddModal(true); }}>
            <Plus size={18} /> Add Product
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {([
          { key: 'products', label: 'Products', icon: <Package size={16} /> },
          { key: 'categories', label: 'Categories', icon: <Folder size={16} /> },
          { key: 'brands', label: 'Brands', icon: <Tag size={16} /> },
          { key: 'suppliers', label: 'Suppliers', icon: <Truck size={16} /> },
        ] as { key: Tab; label: string; icon: React.ReactNode }[]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? 'border-teal-500 text-teal-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'products' && (
        <>
          {/* Search & Filters */}
          <div className="card p-4 space-y-4">
            <div className="flex gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="text"
                  placeholder="Search by name, SKU, or barcode..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 pl-10 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-transparent"
                />
              </div>
              <Select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="w-auto min-w-[140px]">
                <option value="">All Categories</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              <Select value={filterBrand} onChange={(e) => setFilterBrand(e.target.value)} className="w-auto min-w-[140px]">
                <option value="">All Brands</option>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
              <Input placeholder="Size" value={filterSize} onChange={(e) => setFilterSize(e.target.value)} className="w-auto min-w-[100px]" />
              <Input placeholder="Color" value={filterColor} onChange={(e) => setFilterColor(e.target.value)} className="w-auto min-w-[100px]" />
              <label className="flex items-center gap-2 text-sm text-slate-600 whitespace-nowrap">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="rounded" />
                Show Archived
              </label>
            </div>
          </div>

          {/* Products Table */}
          <div className="card overflow-hidden">
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Barcode</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Category</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Size</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Color</th>
                    {hasPermission('products.view_cost') && (
                      <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Cost</th>
                    )}
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Price</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Stock</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-600 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {products.length === 0 ? (
                    <tr>
                      <td colSpan={hasPermission('products.view_cost') ? 9 : 8} className="text-center py-12 text-slate-400">
                        <Package size={40} className="mx-auto mb-2 opacity-40" />
                        <p>No products found</p>
                      </td>
                    </tr>
                  ) : (
                    products.map((p) => (
                      <tr key={p.id} className="table-row-hover">
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900">{p.name}</div>
                          {p.sku && <div className="text-xs text-slate-400">{p.sku}</div>}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600 font-mono">{p.barcode || '—'}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{p.category_name || '—'}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{p.size || '—'}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{p.color || '—'}</td>
                        {hasPermission('products.view_cost') && (
                          <td className="px-4 py-3 text-right text-sm text-slate-600">{formatEgp(p.purchase_cost ?? 0)}</td>
                        )}
                        <td className="px-4 py-3 text-right text-sm font-medium text-slate-900">{formatEgp(p.selling_price)}</td>
                        <td className="px-4 py-3 text-right">
                          {(() => {
                            const displayQty = p.variant_total_stock != null ? p.variant_total_stock : p.quantity;
                            return (
                              <>
                                <span className={`text-sm font-medium ${displayQty <= 0 ? 'text-red-600' : displayQty <= p.min_stock_level ? 'text-amber-600' : 'text-slate-700'}`}>
                                  {formatQuantity(displayQty)}
                                </span>
                                {displayQty <= 0 && <Badge variant="danger">Out</Badge>}
                                {displayQty > 0 && displayQty <= p.min_stock_level && <Badge variant="warning">Low</Badge>}
                              </>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            {p.is_active === 1 ? (
                              <>
                                {hasPermission('products') && (
                                  <button
                                    onClick={() => { setEditingProduct(p); setShowAddModal(true); }}
                                    className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                                    title="Edit"
                                  >
                                    <Pencil size={16} />
                                  </button>
                                )}
                                <button
                                  onClick={() => setLabelTarget(p)}
                                  className="p-1.5 rounded-lg text-slate-500 hover:bg-blue-50 hover:text-blue-600"
                                  title="Print barcode labels"
                                >
                                  <Barcode size={16} />
                                </button>
                                {hasPermission('products') && (
                                  <button
                                    onClick={() => setArchiveTarget(p)}
                                    className="p-1.5 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600"
                                    title="Archive"
                                  >
                                    <Archive size={16} />
                                  </button>
                                )}
                              </>
                            ) : (
                              hasPermission('products') && (
                                <button
                                  onClick={() => handleRestore(p)}
                                  className="p-1.5 rounded-lg text-slate-500 hover:bg-emerald-50 hover:text-emerald-600"
                                  title="Restore"
                                >
                                  <RotateCcw size={16} />
                                </button>
                              )
                            )}
                            {hasPermission('products') && (
                              <button
                                onClick={() => setDeleteTarget(p)}
                                className="p-1.5 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600"
                                title="Delete permanently"
                              >
                                <Trash2 size={16} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'categories' && <CategoriesTab categories={categories} onChanged={loadData} />}
      {tab === 'brands' && <BrandsTab brands={brands} onChanged={loadData} />}
      {tab === 'suppliers' && <SuppliersTab suppliers={suppliers} onChanged={loadData} />}

      {showAddModal && (
        <ProductFormModal
          product={editingProduct}
          categories={categories}
          brands={brands}
          suppliers={suppliers}
          onClose={() => { setShowAddModal(false); setEditingProduct(null); }}
          onSaved={() => { setShowAddModal(false); setEditingProduct(null); loadProducts(); }}
        />
      )}

      {labelTarget && (
        <LabelPrintModal product={labelTarget} onClose={() => setLabelTarget(null)} />
      )}

      <ConfirmDialog
        open={!!archiveTarget}
        title="Archive Product"
        message={`Archive "${archiveTarget?.name}"? The product will be hidden from the active list but kept in the database. Historical sales remain intact.`}
        confirmLabel="Archive"
        onConfirm={() => archiveTarget && handleArchive(archiveTarget)}
        onCancel={() => setArchiveTarget(null)}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Product Permanently"
        message={`Permanently delete "${deleteTarget?.name}"? This cannot be undone. Products with sales or refunds must be archived instead.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

// Product Form Modal
function ProductFormModal({
  product,
  categories,
  brands,
  suppliers,
  onClose,
  onSaved,
}: {
  product: Product | null;
  categories: Category[];
  brands: Brand[];
  suppliers: Supplier[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [form, setForm] = useState({
    name: product?.name || '',
    sku: product?.sku || '',
    barcode: product?.barcode || '',
    category_id: product?.category_id || '',
    brand_id: product?.brand_id || '',
    type: product?.type || '',
    purchase_cost: product && product.purchase_cost != null ? String(product.purchase_cost / 100) : '',
    selling_price: product ? String(product.selling_price / 100) : '',
    quantity: product ? String(product.quantity) : '0',
    min_stock_level: product ? String(product.min_stock_level) : '5',
    supplier_id: product?.supplier_id || '',
    notes: product?.notes || '',
  });

  // ─── Variant draft state (Color × Size matrix) ────────────
  // Entirely local — no database persistence in this phase.
  const [colors, setColors] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [newColor, setNewColor] = useState('');
  const [newSize, setNewSize] = useState('');

  interface MatrixCell { active: boolean; quantity: string; }
  const [matrix, setMatrix] = useState<Record<string, MatrixCell>>({});

  const cellKey = (color: string, size: string) => `${color}__${size}`;

  const addColor = () => {
    const trimmed = newColor.trim();
    if (!trimmed) return;
    if (colors.some((c) => normalizeArabicSearch(c) === normalizeArabicSearch(trimmed))) {
      toast('error', t('Duplicate color name'));
      return;
    }
    setColors((prev) => [...prev, trimmed]);
    setMatrix((prev) => {
      const next = { ...prev };
      for (const s of sizes) {
        const key = cellKey(trimmed, s);
        if (!next[key]) next[key] = { active: true, quantity: '0' };
      }
      return next;
    });
    setNewColor('');
  };

  const removeColor = (color: string) => {
    setColors((prev) => prev.filter((c) => c !== color));
    setMatrix((prev) => {
      const next = { ...prev };
      for (const s of sizes) delete next[cellKey(color, s)];
      return next;
    });
  };

  const addSize = () => {
    const trimmed = newSize.trim();
    if (!trimmed) return;
    if (sizes.some((s) => normalizeArabicSearch(s) === normalizeArabicSearch(trimmed))) {
      toast('error', t('Duplicate size name'));
      return;
    }
    setSizes((prev) => [...prev, trimmed]);
    setMatrix((prev) => {
      const next = { ...prev };
      for (const c of colors) {
        const key = cellKey(c, trimmed);
        if (!next[key]) next[key] = { active: true, quantity: '0' };
      }
      return next;
    });
    setNewSize('');
  };

  const removeSize = (size: string) => {
    setSizes((prev) => prev.filter((s) => s !== size));
    setMatrix((prev) => {
      const next = { ...prev };
      for (const c of colors) delete next[cellKey(c, size)];
      return next;
    });
  };

  const toggleCell = (color: string, size: string) => {
    const key = cellKey(color, size);
    setMatrix((prev) => ({
      ...prev,
      [key]: { ...prev[key], active: !prev[key]?.active },
    }));
  };

  const setCellQuantity = (color: string, size: string, qty: string) => {
    const key = cellKey(color, size);
    setMatrix((prev) => ({
      ...prev,
      [key]: { ...prev[key], quantity: qty },
    }));
  };

  const activeVariantCount = useMemo(() => {
    let count = 0;
    for (const c of colors) for (const s of sizes) if (matrix[cellKey(c, s)]?.active) count++;
    return count;
  }, [colors, sizes, matrix]);

  // ─── Load existing variants when editing ───────────────────
  useEffect(() => {
    if (!product) return;
    let cancelled = false;
    (async () => {
      const res = await query<ProductVariant>(
        'SELECT id, product_id, color, size, quantity, is_active FROM product_variants WHERE product_id = $1 AND is_active = 1',
        [product.id]
      );
      if (cancelled) return;
      const loadedColors = new Set<string>();
      const loadedSizes = new Set<string>();
      const loadedMatrix: Record<string, MatrixCell> = {};
      for (const v of res.rows) {
        const color = (v.color || '').trim();
        const size = (v.size || '').trim();
        if (!color || !size) continue;
        loadedColors.add(color);
        loadedSizes.add(size);
        loadedMatrix[cellKey(color, size)] = {
          active: v.is_active === 1,
          quantity: String(v.quantity),
        };
      }
      const sortedColors = [...loadedColors];
      const sortedSizes = [...loadedSizes];
      setColors(sortedColors);
      setSizes(sortedSizes);
      setMatrix(loadedMatrix);
    })();
    return () => { cancelled = true; };
  }, [product]);

  // ─── Collect active variants from the matrix ──────────────
  const collectVariants = (): Array<{ color: string; size: string; quantity: number; is_active: boolean }> => {
    const variants: Array<{ color: string; size: string; quantity: number; is_active: boolean }> = [];
    for (const c of colors) {
      for (const s of sizes) {
        const cell = matrix[cellKey(c, s)];
        if (cell?.active) {
          const qty = parseLocalizedNumber(cell.quantity) || 0;
          variants.push({
            color: c.trim(),
            size: s.trim(),
            quantity: qty,
            is_active: true,
          });
        }
      }
    }
    return variants;
  };

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const generateBarcode = () => {
    const code = 'EL' + Date.now().toString().slice(-10);
    setForm({ ...form, barcode: code });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    try {
      const cost = toPiasters(form.purchase_cost || '0');
      const price = toPiasters(form.selling_price || '0');

      if (price <= 0) {
        setError('Selling price must be greater than zero');
        setSaving(false);
        return;
      }

      const variants = collectVariants();
      const minStock = parseLocalizedNumber(form.min_stock_level) || 0;

      const productPayload = {
        name: form.name,
        sku: form.sku || null,
        barcode: form.barcode || null,
        category_id: form.category_id ? parseInt(String(form.category_id), 10) : null,
        brand_id: form.brand_id ? parseInt(String(form.brand_id), 10) : null,
        type: form.type || null,
        purchase_cost: cost,
        selling_price: price,
        min_stock_level: minStock,
        supplier_id: form.supplier_id ? parseInt(String(form.supplier_id), 10) : null,
        notes: form.notes || null,
      };

      if (isRunningInElectron() && window.electronAPI.db.saveProductWithVariants) {
        const result = await window.electronAPI.db.saveProductWithVariants(
          {
            product: productPayload,
            productId: product ? product.id : null,
            variants,
          },
          getAuthSessionId()
        );
        if (!result.success || result.productId === undefined) {
          throw new Error(result.error || 'Failed to save product');
        }
        if (product) {
          await logAudit({
            user_id: user?.id ?? null,
            action: 'product_update',
            entity_type: 'product',
            entity_id: product.id,
            new_value: JSON.stringify({ product: productPayload, variants }),
          });
          toast('success', 'Product updated');
        } else {
          toast('success', 'Product created');
        }
      } else {
        // ─── PGlite fallback path ───────────────────────────
        await transaction(async (tx) => {
          let productId: number;

          if (product) {
            productId = product.id;
            await tx.exec(
              `UPDATE products SET
                name = $1, sku = $2, barcode = $3, category_id = $4, brand_id = $5,
                type = $6, size = NULL, color = NULL,
                purchase_cost = $7, selling_price = $8,
                min_stock_level = $9, supplier_id = $10, notes = $11,
                updated_at = datetime('now')
              WHERE id = $12`,
              [
                form.name, form.sku || null, form.barcode || null,
                productPayload.category_id, productPayload.brand_id,
                productPayload.type,
                cost, price, minStock,
                productPayload.supplier_id, productPayload.notes,
                productId,
              ]
            );
          } else {
            const res = await tx.query<{ id: number }>(
              `INSERT INTO products (name, sku, barcode, category_id, brand_id, type, size, color, purchase_cost, selling_price, quantity, min_stock_level, supplier_id, notes)
               VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, $8, 0, $9, $10, $11) RETURNING id`,
              [
                form.name, form.sku || null, form.barcode || null,
                productPayload.category_id, productPayload.brand_id,
                productPayload.type,
                cost, price, minStock,
                productPayload.supplier_id, productPayload.notes,
              ]
            );
            productId = res.rows[0].id;
          }

          // Load existing variants for this product
          const existingRes = await tx.query<{ id: number; color: string; size: string; quantity: number; is_active: number }>(
            'SELECT id, color, size, quantity, is_active FROM product_variants WHERE product_id = $1',
            [productId]
          );
          const existingMap = new Map<string, { id: number; quantity: number; is_active: number }>();
          for (const e of existingRes.rows) {
            existingMap.set(`${normalizeArabicSearch(e.color || '')}|${normalizeArabicSearch(e.size || '')}`, { id: e.id, quantity: e.quantity, is_active: e.is_active });
          }

          const desiredKeys = new Set<string>();
          for (const v of variants) {
            const color = v.color.trim();
            const size = v.size.trim();
            const key = `${normalizeArabicSearch(color)}|${normalizeArabicSearch(size)}`;
            desiredKeys.add(key);

            const ex = existingMap.get(key);
            if (ex) {
              const isActiveInt = v.is_active ? 1 : 0;
              if (ex.quantity !== v.quantity || ex.is_active !== isActiveInt) {
                await tx.exec(
                  'UPDATE product_variants SET quantity = $1, is_active = $2, updated_at = datetime(\'now\') WHERE id = $3',
                  [v.quantity, isActiveInt, ex.id]
                );
              }
            } else {
              const vRes = await tx.query<{ id: number }>(
                'INSERT INTO product_variants (product_id, color, size, quantity, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [productId, color, size, v.quantity, v.is_active ? 1 : 0]
              );
              const variantId = vRes.rows[0].id;
              if (v.quantity > 0) {
                await tx.exec(
                  `INSERT INTO inventory_movements (product_id, variant_id, quantity_change, previous_quantity, new_quantity, reason, reference_type, reference_id, user_id)
                   VALUES ($1, $2, $3, 0, $4, 'Initial stock', 'variant_create', NULL, $5)`,
                  [productId, variantId, v.quantity, v.quantity, user?.id]
                );
              }
            }
          }

          // Deactivate variants no longer in the matrix
          for (const [key, ex] of existingMap) {
            if (!desiredKeys.has(key) && ex.is_active === 1) {
              await tx.exec(
                'UPDATE product_variants SET is_active = 0, updated_at = datetime(\'now\') WHERE id = $1',
                [ex.id]
              );
            }
          }

          await tx.exec(
            `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, new_value)
             VALUES ($1, $2, 'product', $3, $4)`,
            [user?.id ?? null, product ? 'product_update' : 'product_create', productId, JSON.stringify({ product: productPayload, variants })]
          );
        });
        toast('success', product ? 'Product updated' : 'Product created');
      }
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save product';
      setError(msg.includes('unique') || msg.includes('UNIQUE') ? 'SKU or barcode already exists' : msg);
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={product ? 'Edit Product' : 'Add New Product'}
      size="xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving}>{saving ? 'Saving...' : 'Save Product'}</Button>
        </>
      }
    >
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-700">
          <AlertTriangle size={18} /> {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input label={t('Product Name *')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <Input label={t('SKU / Product Code')} value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-slate-700">{t('Barcode')}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={form.barcode}
                onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                className="input-clean flex-1 font-mono"
              />
              <Button type="button" variant="outline" size="sm" onClick={generateBarcode}>
                <Barcode size={16} /> {t('Generate')}
              </Button>
            </div>
          </div>
          <Input label={t('Type')} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} placeholder="e.g. Jalabiya, Ihram" />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Select label={t('Category')} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
            <option value="">— None —</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label={t('Brand')} value={form.brand_id} onChange={(e) => setForm({ ...form, brand_id: e.target.value })}>
            <option value="">— None —</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          <Select label={t('Supplier')} value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
            <option value="">— None —</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Input label={t('Purchase Cost (EGP)')} type="number" step="0.01" value={form.purchase_cost} onChange={(e) => setForm({ ...form, purchase_cost: e.target.value })} />
          <Input label={t('Selling Price (EGP) *')} type="number" step="0.01" value={form.selling_price} onChange={(e) => setForm({ ...form, selling_price: e.target.value })} required />
          {!product && (
            <Input label={t('Initial Stock Quantity')} type="number" step="0.01" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          )}
        </div>
        <div className="grid grid-cols-1 gap-4">
          <Input label={t('Minimum Stock Level')} type="number" step="0.01" value={form.min_stock_level} onChange={(e) => setForm({ ...form, min_stock_level: e.target.value })} />
        </div>

        {/* ─── Variant Matrix Editor ─────────────────────────── */}
        <div className="border border-slate-200 rounded-xl p-4 space-y-4 bg-slate-50/50">
          <div className="flex items-center gap-2">
            <Grid3x3 size={18} className="text-teal-600" />
            <h3 className="text-sm font-semibold text-slate-900">{t('Variants (Color × Size)')}</h3>
            {activeVariantCount > 0 && (
              <Badge variant="info">{activeVariantCount} {t('Active')}</Badge>
            )}
          </div>
          <p className="text-xs text-slate-500">{t('Add colors and sizes to generate variant combinations automatically')}</p>

          {/* Colors row */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <Palette size={15} className="text-slate-500" /> {t('Colors')}
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              {colors.map((c) => (
                <span key={c} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-teal-50 border border-teal-200 text-sm text-teal-800">
                  {c}
                  <button type="button" onClick={() => removeColor(c)} className="text-teal-400 hover:text-teal-700">
                    <X size={14} />
                  </button>
                </span>
              ))}
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addColor(); } }}
                  placeholder={t('Color name')}
                  className="w-28 rounded-lg border border-slate-300 px-2.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-transparent"
                />
                <Button type="button" variant="outline" size="sm" onClick={addColor}>
                  <Plus size={14} /> {t('Add Color')}
                </Button>
              </div>
            </div>
          </div>

          {/* Sizes row */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <Ruler size={15} className="text-slate-500" /> {t('Sizes')}
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              {sizes.map((s) => (
                <span key={s} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800">
                  {s}
                  <button type="button" onClick={() => removeSize(s)} className="text-blue-400 hover:text-blue-700">
                    <X size={14} />
                  </button>
                </span>
              ))}
              <div className="flex gap-1.5 items-center">
                <input
                  type="text"
                  value={newSize}
                  onChange={(e) => setNewSize(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSize(); } }}
                  placeholder={t('Size name')}
                  className="w-28 rounded-lg border border-slate-300 px-2.5 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-transparent"
                />
                <Button type="button" variant="outline" size="sm" onClick={addSize}>
                  <Plus size={14} /> {t('Add Size')}
                </Button>
              </div>
            </div>
          </div>

          {/* Matrix grid */}
          {colors.length === 0 || sizes.length === 0 ? (
            <div className="text-center py-6 text-sm text-slate-400">
              <Grid3x3 size={28} className="mx-auto mb-2 opacity-40" />
              {t('Add at least one color and one size to see the matrix')}
            </div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin border border-slate-200 rounded-lg bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-3 py-2 text-xs font-semibold text-slate-600 uppercase tracking-wider whitespace-nowrap">
                      {t('Size')} \ {t('Colors')}
                    </th>
                    {colors.map((c) => (
                      <th key={c} className="px-2 py-2 text-xs font-semibold text-slate-700 text-center whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sizes.map((s) => (
                    <tr key={s} className="hover:bg-slate-50/50">
                      <td className="px-3 py-2 text-sm font-medium text-slate-700 whitespace-nowrap">{s}</td>
                      {colors.map((c) => {
                        const key = cellKey(c, s);
                        const cell = matrix[key];
                        const isActive = cell?.active ?? false;
                        return (
                          <td key={key} className="px-2 py-1.5 text-center">
                            {isActive ? (
                              <div className="flex flex-col items-center gap-1">
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  min="0"
                                  step="0.01"
                                  value={cell?.quantity ?? '0'}
                                  onChange={(e) => setCellQuantity(c, s, e.target.value)}
                                  className="w-16 text-center text-sm border border-slate-300 rounded-md px-1.5 py-1 focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-transparent"
                                  placeholder="0"
                                />
                                <button
                                  type="button"
                                  onClick={() => toggleCell(c, s)}
                                  className="text-[10px] text-slate-400 hover:text-red-500 transition-colors"
                                  title={t('Disable')}
                                >
                                  {t('Disable')}
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => toggleCell(c, s)}
                                className="text-xs text-slate-300 hover:text-teal-600 transition-colors py-1 px-2 rounded-md hover:bg-teal-50"
                                title={t('This combination is not available')}
                              >
                                —
                              </button>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {activeVariantCount > 0 && (
            <p className="text-xs text-slate-500">
              {t('Total active variants')}: <span className="font-semibold text-slate-700">{activeVariantCount}</span>
            </p>
          )}
        </div>

        <Textarea label={t('Notes')} rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </form>
    </Modal>
  );
}

// Categories Tab
function CategoriesTab({ categories, onChanged }: { categories: Category[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');

  const addCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await execute('INSERT INTO categories (name) VALUES ($1)', [name.trim()]);
      toast('success', 'Category added');
      setName('');
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast('error', msg.includes('unique') || msg.includes('UNIQUE') ? 'Category already exists' : msg || 'Failed to add category');
    }
  };

  const updateCategory = async (id: number) => {
    if (!editName.trim()) return;
    try {
      await execute('UPDATE categories SET name = $1 WHERE id = $2', [editName.trim(), id]);
      toast('success', 'Category updated');
      setEditingId(null);
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast('error', msg || 'Failed to update category');
    }
  };

  const deleteCategory = async (id: number) => {
    try {
      await execute('DELETE FROM categories WHERE id = $1', [id]);
      toast('success', 'Category deleted');
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast('error', msg.includes('foreign') || msg.includes('FOREIGN') || msg.includes('constraint') ? 'Cannot delete category in use' : msg || 'Failed to delete category');
    }
  };

  return (
    <div className="card p-6">
      <form onSubmit={addCategory} className="flex gap-3 mb-6">
        <Input placeholder="New category name" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
        <Button type="submit"><Plus size={18} /> Add</Button>
      </form>
      <div className="space-y-2">
        {categories.length === 0 ? (
          <p className="text-center text-slate-400 py-8">No categories yet</p>
        ) : (
          categories.map((c) => (
            <div key={c.id} className="flex items-center justify-between p-3 rounded-lg border border-slate-200 hover:bg-slate-50">
              {editingId === c.id ? (
                <div className="flex items-center gap-2 flex-1">
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="flex-1" autoFocus />
                  <Button size="sm" onClick={() => updateCategory(c.id)}>Save</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
                </div>
              ) : (
                <>
                  <span className="text-sm font-medium text-slate-700">{c.name}</span>
                  <div className="flex gap-1">
                    <button onClick={() => { setEditingId(c.id); setEditName(c.name); }} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => deleteCategory(c.id)} className="p-1.5 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600">
                      <X size={16} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Brands Tab
function BrandsTab({ brands, onChanged }: { brands: Brand[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');

  const addBrand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await execute('INSERT INTO brands (name) VALUES ($1)', [name.trim()]);
      toast('success', 'Brand added');
      setName('');
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast('error', msg.includes('unique') || msg.includes('UNIQUE') ? 'Brand already exists' : msg || 'Failed to add brand');
    }
  };

  const updateBrand = async (id: number) => {
    if (!editName.trim()) return;
    try {
      await execute('UPDATE brands SET name = $1 WHERE id = $2', [editName.trim(), id]);
      toast('success', 'Brand updated');
      setEditingId(null);
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast('error', msg || 'Failed to update brand');
    }
  };

  const deleteBrand = async (id: number) => {
    try {
      await execute('DELETE FROM brands WHERE id = $1', [id]);
      toast('success', 'Brand deleted');
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast('error', msg.includes('foreign') || msg.includes('FOREIGN') || msg.includes('constraint') ? 'Cannot delete brand in use' : msg || 'Failed to delete brand');
    }
  };

  return (
    <div className="card p-6">
      <form onSubmit={addBrand} className="flex gap-3 mb-6">
        <Input placeholder="New brand name" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
        <Button type="submit"><Plus size={18} /> Add</Button>
      </form>
      <div className="space-y-2">
        {brands.length === 0 ? (
          <p className="text-center text-slate-400 py-8">No brands yet</p>
        ) : (
          brands.map((b) => (
            <div key={b.id} className="flex items-center justify-between p-3 rounded-lg border border-slate-200 hover:bg-slate-50">
              {editingId === b.id ? (
                <div className="flex items-center gap-2 flex-1">
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="flex-1" autoFocus />
                  <Button size="sm" onClick={() => updateBrand(b.id)}>Save</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
                </div>
              ) : (
                <>
                  <span className="text-sm font-medium text-slate-700">{b.name}</span>
                  <div className="flex gap-1">
                    <button onClick={() => { setEditingId(b.id); setEditName(b.name); }} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => deleteBrand(b.id)} className="p-1.5 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600">
                      <X size={16} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Suppliers Tab
function SuppliersTab({ suppliers, onChanged }: { suppliers: Supplier[]; onChanged: () => void }) {
  const [form, setForm] = useState({ name: '', phone: '', notes: '' });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: '', phone: '', notes: '' });

  const addSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    try {
      await execute('INSERT INTO suppliers (name, phone, notes) VALUES ($1, $2, $3)', [form.name.trim(), form.phone || null, form.notes || null]);
      toast('success', 'Supplier added');
      setForm({ name: '', phone: '', notes: '' });
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast('error', msg.includes('unique') || msg.includes('UNIQUE') ? 'Supplier already exists' : msg || 'Failed to add supplier');
    }
  };

  const updateSupplier = async (id: number) => {
    if (!editForm.name.trim()) return;
    try {
      await execute('UPDATE suppliers SET name = $1, phone = $2, notes = $3 WHERE id = $4', [editForm.name.trim(), editForm.phone || null, editForm.notes || null, id]);
      toast('success', 'Supplier updated');
      setEditingId(null);
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast('error', msg || 'Failed to update supplier');
    }
  };

  const deleteSupplier = async (id: number) => {
    try {
      await execute('DELETE FROM suppliers WHERE id = $1', [id]);
      toast('success', 'Supplier deleted');
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast('error', msg.includes('foreign') || msg.includes('FOREIGN') || msg.includes('constraint') ? 'Cannot delete supplier in use' : msg || 'Failed to delete supplier');
    }
  };

  return (
    <div className="card p-6">
      <form onSubmit={addSupplier} className="grid grid-cols-3 gap-3 mb-6 p-4 rounded-lg bg-slate-50">
        <Input placeholder="Supplier name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <Input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <Input placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        <div className="col-span-3">
          <Button type="submit"><Plus size={18} /> Add Supplier</Button>
        </div>
      </form>
      <div className="space-y-2">
        {suppliers.length === 0 ? (
          <p className="text-center text-slate-400 py-8">No suppliers yet</p>
        ) : (
          suppliers.map((s) => (
            <div key={s.id} className="p-3 rounded-lg border border-slate-200 hover:bg-slate-50">
              {editingId === s.id ? (
                <div className="grid grid-cols-3 gap-2">
                  <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} placeholder="Name" />
                  <Input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} placeholder="Phone" />
                  <Input value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} placeholder="Notes" />
                  <div className="col-span-3 flex gap-2">
                    <Button size="sm" onClick={() => updateSupplier(s.id)}>Save</Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-slate-700">{s.name}</span>
                    {s.phone && <span className="text-xs text-slate-400 ml-3">{s.phone}</span>}
                    {s.notes && <p className="text-xs text-slate-400 mt-0.5">{s.notes}</p>}
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => { setEditingId(s.id); setEditForm({ name: s.name, phone: s.phone || '', notes: s.notes || '' }); }} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => deleteSupplier(s.id)} className="p-1.5 rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600">
                      <X size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Barcode Label Print Modal
function LabelPrintModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const { get } = useSettings();
  const [copies, setCopies] = useState(1);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState('');
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    (async () => {
      const list = await getPrinters();
      setPrinters(list);
      const def = list.find((p) => p.isDefault);
      setSelectedPrinter(def?.name || list[0]?.name || '');
    })();
  }, []);

  const handlePrint = async () => {
    if (copies < 1 || copies > 1000) return;
    setPrinting(true);
    const storeName = get('store_name', 'ELAKRAMMEN');
    const html = generateLabelHtml({
      productName: product.name,
      barcode: product.barcode || product.sku || String(product.id),
      price: product.selling_price,
      storeName,
      size: product.size || undefined,
      color: product.color || undefined,
    }, copies);
    const result = await printHtml(html, {
      silent: !!selectedPrinter,
      printerName: selectedPrinter || undefined,
      pageSize: { width: 40000, height: 25000 },
    });
    if (result.success) {
      toast('success', `Printing ${copies} label(s)`);
      onClose();
    } else {
      toast('error', result.error || 'Printing failed');
    }
    setPrinting(false);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Print Barcode Labels"
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handlePrint} disabled={printing || copies < 1}>
            {printing ? <Loader2 size={18} className="animate-spin" /> : <Printer size={18} />}
            {printing ? 'Printing...' : `Print ${copies} Label${copies > 1 ? 's' : ''}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="bg-slate-50 rounded-lg p-4">
          <p className="text-sm font-medium text-slate-900">{product.name}</p>
          {product.sku && <p className="text-xs text-slate-500 mt-1">SKU: {product.sku}</p>}
          <p className="text-xs text-slate-500 font-mono mt-1">Barcode: {product.barcode || '—'}</p>
          <p className="text-sm font-bold text-slate-900 mt-2">{formatEgp(product.selling_price)}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Number of Labels</label>
          <input
            type="text"
            inputMode="numeric"
            min="1"
            max="1000"
            value={copies}
            onChange={(e) => setCopies(Math.max(1, Math.min(1000, parseLocalizedNumber(e.target.value) || 1)))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          />
          <p className="text-xs text-slate-400 mt-1">Maximum 1000 labels per print</p>
        </div>

        {printers.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Printer</label>
            <select
              value={selectedPrinter}
              onChange={(e) => setSelectedPrinter(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {printers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.displayName || p.name} {p.isDefault ? '(Default)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="border border-slate-200 rounded-lg p-4 flex justify-center bg-white">
          <div className="text-center" style={{ width: '200px', border: '1px dashed #ccc', padding: '8px' }}>
            <p className="text-xs font-bold">{get('store_name', 'ELAKRAMMEN')}</p>
            <p className="text-xs truncate">{product.name}</p>
            {(product.size || product.color) && (
              <p className="text-xs text-slate-500">{[product.size, product.color].filter(Boolean).join(' / ')}</p>
            )}
            <div className="my-2 flex justify-center">
              <Barcode size={48} className="text-slate-900" />
            </div>
            <p className="text-sm font-bold">{formatEgp(product.selling_price)}</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
