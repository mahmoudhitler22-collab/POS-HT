import { useState, useEffect, useCallback, useRef } from 'react';
import { getAuthSessionId, query, transaction } from '@/db/client';
import { useAuth } from '@/context/AuthContext';
import { useSettings } from '@/context/SettingsContext';
import { logAudit } from '@/lib/audit';
import { formatEgp, formatQuantity, parseLocalizedNumber, toPiasters } from '@/lib/money';
import { arabicSearchPattern, normalizeArabicSql } from '@/lib/search';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Receipt } from '@/components/Receipt';
import type { Product, ProductVariant, CartItem, Sale } from '@/types';
import {
  Search, Plus, Minus, Trash2, ShoppingCart, Barcode,
  CreditCard, Banknote, Smartphone, Wallet, Check
} from 'lucide-react';

type PosProduct = Product & { variant_count: number; variant_total_stock: number };

const cartItemKey = (productId: number, variantId: number | null) =>
  `${productId}:${variantId ?? 'product'}`;

export function PosPage() {
  const { user, hasPermission } = useAuth();
  const { get } = useSettings();
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<PosProduct[]>([]);
  const [variantProduct, setVariantProduct] = useState<PosProduct | null>(null);
  const [variantChoices, setVariantChoices] = useState<ProductVariant[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [customerId, setCustomerId] = useState<string>('');
  const [customers, setCustomers] = useState<{ id: number; name: string; phone: string | null }[]>([]);
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [isCompletingSale, setIsCompletingSale] = useState(false);
  const [completedSale, setCompletedSale] = useState<Sale | null>(null);
  const [globalDiscountType, setGlobalDiscountType] = useState<'percentage' | 'fixed' | 'none'>('none');
  const [globalDiscountValue, setGlobalDiscountValue] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const barcodeBufferRef = useRef<string>('');
  const lastKeyTimeRef = useRef<number>(0);
  const completingSaleRef = useRef(false);

  const paymentMethods: string[] = (() => {
    try { return JSON.parse(get('payment_methods', '["Cash","Card / Visa","Instapay","Other"]')); }
    catch { return ['Cash', 'Card / Visa', 'Instapay', 'Other']; }
  })();

  const allowNegativeStock = get('allow_negative_stock', '0') === '1';

  const loadCustomers = useCallback(async () => {
    const res = await query<{ id: number; name: string; phone: string | null }>('SELECT id, name, phone FROM customers ORDER BY name');
    setCustomers(res.rows);
  }, []);
  useEffect(() => { loadCustomers(); }, [loadCustomers]);

  // Search products
  useEffect(() => {
    if (!search.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const res = await query<PosProduct>(
        `SELECT p.*,
                (SELECT COUNT(*) FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1) AS variant_count,
                COALESCE((SELECT SUM(pv.quantity) FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1), 0) AS variant_total_stock
           FROM products p
           WHERE p.is_active = 1 AND (${normalizeArabicSql('p.name')} LIKE $1 OR ${normalizeArabicSql('p.sku')} LIKE $1 OR ${normalizeArabicSql('p.barcode')} LIKE $1 OR ${normalizeArabicSql('p.color')} LIKE $1 OR ${normalizeArabicSql('p.size')} LIKE $1)
           ORDER BY p.name LIMIT 20`,
        [arabicSearchPattern(search)]
      );
      setSearchResults(res.rows);
    }, 150);
    return () => clearTimeout(timer);
  }, [search]);

  // Barcode scanner detection (USB scanners act as fast keyboard input)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only capture if focused on search input
      if (document.activeElement !== searchRef.current) return;

      const now = Date.now();
      if (now - lastKeyTimeRef.current > 100) {
        barcodeBufferRef.current = '';
      }
      lastKeyTimeRef.current = now;

      if (e.key === 'Enter') {
        const code = barcodeBufferRef.current.trim();
        if (code.length >= 4) {
          e.preventDefault();
          handleBarcodeScan(code);
          barcodeBufferRef.current = '';
        } else if (search.trim()) {
          // Normal search enter — try exact barcode match first
          handleBarcodeScan(search.trim());
        }
        return;
      }

      if (e.key.length === 1) {
        barcodeBufferRef.current += e.key;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [search]);

  const handleBarcodeScan = async (code: string) => {
    const variantRes = await query<ProductVariant & { product_name: string; product_sku: string | null; product_barcode: string | null; product_selling_price: number; product_purchase_cost: number; product_min_stock_level: number }>(
      `SELECT pv.*, p.name AS product_name, p.sku AS product_sku, p.barcode AS product_barcode,
              p.selling_price AS product_selling_price, p.purchase_cost AS product_purchase_cost,
              p.min_stock_level AS product_min_stock_level
         FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
        WHERE pv.is_active = 1 AND p.is_active = 1 AND pv.barcode = $1`,
      [code]
    );
    if (variantRes.rows.length > 0) {
      const variant = variantRes.rows[0];
      addToCart({
        id: variant.product_id,
        name: variant.product_name,
        sku: variant.product_sku,
        barcode: variant.product_barcode,
        selling_price: variant.product_selling_price,
        purchase_cost: variant.product_purchase_cost,
        min_stock_level: variant.product_min_stock_level,
        quantity: 0,
        variant_count: 1,
        variant_total_stock: variant.quantity,
      } as PosProduct, variant);
      setSearch('');
      setSearchResults([]);
      toast('success', `Added: ${variant.product_name}`);
    } else {
      // Try as SKU
      const skuRes = await query<PosProduct>(
        `SELECT p.*,
                (SELECT COUNT(*) FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1) AS variant_count,
                COALESCE((SELECT SUM(pv.quantity) FROM product_variants pv WHERE pv.product_id = p.id AND pv.is_active = 1), 0) AS variant_total_stock
           FROM products p WHERE p.is_active = 1 AND (p.barcode = $1 OR p.sku = $1)`,
        [code]
      );
      if (skuRes.rows.length > 0) {
        void selectProduct(skuRes.rows[0]);
        setSearch('');
        setSearchResults([]);
        toast('success', `Added: ${skuRes.rows[0].name}`);
      } else {
        toast('error', `No product found for barcode: ${code}`);
      }
    }
  };

  const selectProduct = async (product: PosProduct) => {
    if (Number(product.variant_count) > 0) {
      const variants = await query<ProductVariant>(
        'SELECT * FROM product_variants WHERE product_id = $1 AND is_active = 1 ORDER BY color, size',
        [product.id]
      );
      setVariantProduct(product);
      setVariantChoices(variants.rows);
      return;
    }
    addToCart(product);
  };

  const addToCart = (product: Product, variant: ProductVariant | null = null) => {
    const availableStock = variant?.quantity ?? product.quantity;
    if (!allowNegativeStock && availableStock <= 0) {
      toast('error', `${product.name} is out of stock`);
      return;
    }
    const variantLabel = variant ? [variant.color, variant.size].filter(Boolean).join(' / ') : null;
    const key = cartItemKey(product.id, variant?.id ?? null);
    setCart((prev) => {
      const existing = prev.find((item) => cartItemKey(item.product_id, item.variant_id) === key);
      if (existing) {
        if (!allowNegativeStock && existing.quantity + 1 > availableStock) {
          toast('error', `Only ${formatQuantity(availableStock)} in stock`);
          return prev;
        }
        return prev.map((item) =>
          cartItemKey(item.product_id, item.variant_id) === key ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, {
        product_id: product.id,
        variant_id: variant?.id ?? null,
        variant_label: variantLabel,
        name: variantLabel ? `${product.name} — ${variantLabel}` : product.name,
        barcode: variant?.barcode ?? product.barcode,
        unit_price: variant?.selling_price ?? product.selling_price,
        quantity: 1,
        discount_type: null,
        discount_value: 0,
        available_stock: availableStock,
        cost: variant?.purchase_cost ?? product.purchase_cost ?? 0,
      }];
    });
  };

  const updateQuantity = (itemKey: string, delta: number) => {
    setCart((prev) => {
      return prev.map((item) => {
        if (cartItemKey(item.product_id, item.variant_id) !== itemKey) return item;
        const newQty = item.quantity + delta;
        if (newQty <= 0) return item;
        if (!allowNegativeStock && newQty > item.available_stock) {
          toast('error', `Only ${formatQuantity(item.available_stock)} in stock`);
          return item;
        }
        return { ...item, quantity: newQty };
      });
    });
  };

  const setQuantity = (itemKey: string, qty: number) => {
    setCart((prev) => prev.map((item) => {
      if (cartItemKey(item.product_id, item.variant_id) !== itemKey) return item;
      if (qty <= 0) return item;
      if (!allowNegativeStock && qty > item.available_stock) {
        toast('error', `Only ${formatQuantity(item.available_stock)} in stock`);
        return item;
      }
      return { ...item, quantity: qty };
    }));
  };

  const removeItem = (itemKey: string) => {
    setCart((prev) => prev.filter((item) => cartItemKey(item.product_id, item.variant_id) !== itemKey));
  };

  const setItemDiscount = (itemKey: string, type: 'percentage' | 'fixed' | null, value: number) => {
    setCart((prev) => prev.map((item) =>
      cartItemKey(item.product_id, item.variant_id) === itemKey
        ? { ...item, discount_type: type, discount_value: value }
        : item
    ));
  };

  // Calculate each item's discount before applying any sale-wide discount.
  const cartWithItemDiscounts = cart.map((item) => {
    let lineTotal = item.unit_price * item.quantity;
    let discountAmount = 0;
    if (item.discount_type === 'percentage' && item.discount_value > 0) {
      discountAmount = Math.round(lineTotal * item.discount_value / 100);
    } else if (item.discount_type === 'fixed' && item.discount_value > 0) {
      discountAmount = Math.min(toPiasters(item.discount_value), lineTotal);
    }
    lineTotal -= discountAmount;
    return { ...item, itemDiscountAmount: discountAmount, lineTotal };
  });

  const subtotal = cartWithItemDiscounts.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  const itemDiscounts = cartWithItemDiscounts.reduce((sum, item) => sum + item.itemDiscountAmount, 0);
  const totalAfterItemDiscounts = subtotal - itemDiscounts;

  let globalDiscountAmount = 0;
  if (globalDiscountType === 'percentage' && globalDiscountValue) {
    globalDiscountAmount = Math.round(totalAfterItemDiscounts * parseLocalizedNumber(globalDiscountValue) / 100);
  } else if (globalDiscountType === 'fixed' && globalDiscountValue) {
    globalDiscountAmount = Math.min(toPiasters(globalDiscountValue), totalAfterItemDiscounts);
  }

  // Allocate the sale-wide discount to individual lines. This ensures a
  // later partial refund returns the price the customer actually paid.
  let remainingGlobalDiscount = globalDiscountAmount;
  const cartWithTotals = cartWithItemDiscounts.map((item, index) => {
    const isLastItem = index === cartWithItemDiscounts.length - 1;
    const globalLineDiscount = isLastItem
      ? remainingGlobalDiscount
      : totalAfterItemDiscounts > 0
        ? Math.min(
          remainingGlobalDiscount,
          Math.round(item.lineTotal * globalDiscountAmount / totalAfterItemDiscounts)
        )
        : 0;
    remainingGlobalDiscount -= globalLineDiscount;
    const discountAmount = item.itemDiscountAmount + globalLineDiscount;
    const finalPrice = item.lineTotal - globalLineDiscount;
    return { ...item, discountAmount, globalLineDiscount, lineTotal: finalPrice, finalPrice };
  });

  const totalDiscount = itemDiscounts + globalDiscountAmount;
  const total = subtotal - totalDiscount;

  const maxDiscountPct = parseLocalizedNumber(get('max_discount_percentage', '20'));

  const completeSale = async () => {
    if (completingSaleRef.current) return;
    if (cart.length === 0) {
      toast('error', 'Cart is empty');
      return;
    }

    // Validate discount limits
    if (globalDiscountType === 'percentage' && globalDiscountValue) {
      const pct = parseLocalizedNumber(globalDiscountValue);
      if (pct > maxDiscountPct) {
        toast('error', `Maximum discount is ${maxDiscountPct}%`);
        return;
      }
    }
    for (const item of cartWithTotals) {
      if (item.discount_type === 'percentage' && item.discount_value > maxDiscountPct) {
        toast('error', `Discount on ${item.name} exceeds maximum of ${maxDiscountPct}%`);
        return;
      }
    }

    completingSaleRef.current = true;
    setIsCompletingSale(true);
    try {
      let sale: Sale;
      if (window.electronAPI) {
        const result = await window.electronAPI.db.completeSale({
          customerId: customerId ? parseInt(customerId, 10) : null,
          paymentMethod,
          globalDiscount: {
            type: globalDiscountType,
            value: parseLocalizedNumber(globalDiscountValue) || 0,
          },
          items: cart.map((item) => ({
            productId: item.product_id,
            variantId: item.variant_id,
            quantity: item.quantity,
            discountType: item.discount_type,
            discountValue: item.discount_value,
          })),
        }, getAuthSessionId());
        if (!result.success || !result.sale) throw new Error(result.error || 'Sale failed');
        sale = result.sale as Sale;
      } else {
        sale = await transaction(async (tx) => {
        // Generate invoice number
        const counterRes = await tx.query<{ value: string }>("SELECT value FROM settings WHERE key = 'invoice_counter'");
        const counter = parseInt(counterRes.rows[0].value, 10) + 1;
        const prefix = get('invoice_prefix', 'INV');
        const invoiceNumber = `${prefix}-${String(counter).padStart(6, '0')}`;

        await tx.exec("UPDATE settings SET value = $1 WHERE key = 'invoice_counter'", [String(counter)]);

        const custId = customerId ? parseInt(customerId, 10) : null;

        // Create sale record
        const saleRes = await tx.query<{ id: number }>(
          `INSERT INTO sales (invoice_number, customer_id, cashier_id, subtotal, discount_amount, total, payment_method, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed') RETURNING id`,
          [invoiceNumber, custId, user!.id, subtotal, totalDiscount, total, paymentMethod]
        );
        const saleId = saleRes.rows[0].id;

        // Create sale items + update inventory
        for (const item of cartWithTotals) {
          await tx.exec(
            `INSERT INTO sale_items (sale_id, product_id, variant_id, product_name, unit_price, quantity, discount_type, discount_value, discount_amount, final_price, cost_at_sale, line_total)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              saleId, item.product_id, item.variant_id, item.name, item.unit_price, item.quantity,
              item.discount_type, toPiasters(item.discount_value), item.discountAmount,
              item.finalPrice, item.cost, item.lineTotal
            ]
          );

          // Variants hold their own inventory; regular products use the parent quantity.
          const stockRes = item.variant_id === null
            ? await tx.query<{ quantity: number }>('SELECT quantity FROM products WHERE id = $1', [item.product_id])
            : await tx.query<{ quantity: number }>('SELECT quantity FROM product_variants WHERE id = $1 AND product_id = $2', [item.variant_id, item.product_id]);
          const prevQty = stockRes.rows[0]?.quantity;
          if (prevQty === undefined) throw new Error(`Stock record for ${item.name} was not found`);
          if (!allowNegativeStock && prevQty < item.quantity) {
            throw new Error(`Insufficient stock for ${item.name}`);
          }
          const newQty = prevQty - item.quantity;

          if (item.variant_id === null) {
            await tx.exec('UPDATE products SET quantity = $1, updated_at = datetime(\'now\') WHERE id = $2', [newQty, item.product_id]);
          } else {
            await tx.exec('UPDATE product_variants SET quantity = $1, updated_at = datetime(\'now\') WHERE id = $2', [newQty, item.variant_id]);
          }

          await tx.exec(
            `INSERT INTO inventory_movements (product_id, variant_id, quantity_change, previous_quantity, new_quantity, reason, reference_type, reference_id, user_id)
             VALUES ($1, $2, $3, $4, $5, 'Sale', 'sale', $6, $7)`,
            [item.product_id, item.variant_id, -item.quantity, prevQty, newQty, saleId, user!.id]
          );
        }

        // Record payment
        await tx.exec(
          'INSERT INTO payments (sale_id, method, amount) VALUES ($1, $2, $3)',
          [saleId, paymentMethod, total]
        );

        // Update customer stats
        if (custId) {
          await tx.exec(
            `UPDATE customers SET
              total_purchases = total_purchases + $1,
              purchase_count = purchase_count + 1,
              yearly_purchases = yearly_purchases + $1,
              last_purchase_date = datetime('now')
            WHERE id = $2`,
            [total, custId]
          );

          // Loyalty points: 10 points per EGP 1,000 (whole units only)
          if (get('loyalty_enabled', '0') === '1') {
            const pointsPer1000 = parseLocalizedNumber(get('loyalty_points_per_1000_egp', '10'));
            const totalEgp = Math.floor(total / 100); // piasters to EGP
            const points = Math.floor(totalEgp / 1000) * pointsPer1000;
            if (points > 0) {
              await tx.exec('UPDATE customers SET loyalty_points = loyalty_points + $1 WHERE id = $2', [points, custId]);
              await tx.exec(
                'INSERT INTO loyalty_transactions (customer_id, sale_id, points, reason) VALUES ($1, $2, $3, $4)',
                [custId, saleId, points, `Sale ${invoiceNumber}`]
              );
            }
          }
        }

        return { id: saleId, invoice_number: invoiceNumber } as Sale;
        });
      }

      // The desktop handler writes the audit entry atomically with the sale.
      if (!window.electronAPI) {
        await logAudit({
          user_id: user?.id ?? null,
          action: 'sale_complete',
          entity_type: 'sale',
          entity_id: sale.id,
          new_value: JSON.stringify({ invoice: sale.invoice_number, total, payment_method: paymentMethod }),
        });
      }

      setCompletedSale(window.electronAPI ? sale : { ...sale, total, payment_method: paymentMethod, subtotal, discount_amount: totalDiscount, customer_id: customerId ? parseInt(customerId, 10) : null, cashier_id: user!.id, status: 'completed', notes: null, created_at: new Date().toISOString() } as Sale);
      setCart([]);
      setCustomerId('');
      setGlobalDiscountType('none');
      setGlobalDiscountValue('');
      setShowPaymentModal(false);
      toast('success', `Sale completed: ${sale.invoice_number}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sale failed';
      toast('error', `Sale failed: ${msg}`);
    } finally {
      completingSaleRef.current = false;
      setIsCompletingSale(false);
    }
  };

  const paymentIcons: Record<string, React.ReactNode> = {
    Cash: <Banknote size={18} />,
    'Card / Visa': <CreditCard size={18} />,
    Instapay: <Smartphone size={18} />,
    Other: <Wallet size={18} />,
  };

  return (
    <div className="flex h-[calc(100vh-3rem)] gap-6 -m-6">
      {/* Left: Product Search */}
      <div className="flex-1 flex flex-col">
        <div className="p-6 pb-3">
          <h1 className="text-2xl font-bold text-slate-900 mb-4">Point of Sale</h1>
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search product name, scan barcode, or enter SKU..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              className="w-full rounded-xl border border-slate-300 pl-12 pr-4 py-3.5 text-base focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent shadow-sm"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6 scrollbar-thin">
          {search.trim() === '' ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-300">
              <Barcode size={64} className="mb-4" />
              <p className="text-lg font-medium text-slate-400">Search or scan to start a sale</p>
              <p className="text-sm text-slate-400 mt-1">Use the search bar above to find products</p>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <p>No products found for "{search}"</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {searchResults.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { void selectProduct(p); }}
                  className="card p-4 text-left hover:border-teal-400 hover:shadow-md transition-all group"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="font-medium text-slate-900 group-hover:text-teal-600 transition-colors">{p.name}</div>
                    {Number(p.variant_count) > 0 ? <span className="text-xs text-teal-600 font-medium">Variants</span> :
                      p.quantity <= 0 ? <span className="text-xs text-red-500 font-medium">Out</span> :
                        p.quantity <= p.min_stock_level && <span className="text-xs text-amber-500 font-medium">Low</span>}
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-lg font-bold text-slate-900">{formatEgp(p.selling_price)}</div>
                    <div className="text-xs text-slate-400">Stock: {formatQuantity(Number(p.variant_count) > 0 ? Number(p.variant_total_stock) : p.quantity)}</div>
                  </div>
                  {(p.size || p.color) && (
                    <div className="flex gap-2 mt-1.5">
                      {p.size && <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600">{p.size}</span>}
                      {p.color && <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600">{p.color}</span>}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right: Cart */}
      <div className="w-[440px] flex flex-col bg-white border-l border-slate-200 flex-shrink-0">
        <div className="p-5 border-b border-slate-200">
          <div className="flex items-center gap-2 mb-3">
            <ShoppingCart size={20} className="text-slate-700" />
            <h2 className="text-lg font-semibold text-slate-900">Current Sale</h2>
            {cart.length > 0 && (
              <button onClick={() => setCart([])} className="ml-auto text-xs text-red-500 hover:text-red-700 font-medium">
                Clear All
              </button>
            )}
          </div>
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="text-sm">
            <option value="">Walk-in Customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.phone ? ` — ${c.phone}` : ''}</option>
            ))}
          </Select>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {cart.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-300 p-8">
              <ShoppingCart size={48} className="mb-3" />
              <p className="text-sm">Cart is empty</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {cartWithTotals.map((item) => (
                <div key={cartItemKey(item.product_id, item.variant_id)} className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-900 text-sm truncate">{item.name}</p>
                      <p className="text-xs text-slate-400">{formatEgp(item.unit_price)} each</p>
                    </div>
                    <button onClick={() => removeItem(cartItemKey(item.product_id, item.variant_id))} className="p-1 text-slate-400 hover:text-red-500">
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center border border-slate-200 rounded-lg">
                      <button onClick={() => updateQuantity(cartItemKey(item.product_id, item.variant_id), -1)} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-l-lg">
                        <Minus size={14} />
                      </button>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={item.quantity}
                        onChange={(e) => setQuantity(cartItemKey(item.product_id, item.variant_id), parseLocalizedNumber(e.target.value) || 1)}
                        className="w-12 text-center text-sm border-0 focus:outline-none py-1.5"
                      />
                      <button onClick={() => updateQuantity(cartItemKey(item.product_id, item.variant_id), 1)} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-r-lg">
                        <Plus size={14} />
                      </button>
                    </div>
                    <div className="flex-1 text-right">
                      {item.discountAmount > 0 && (
                        <span className="text-xs text-red-500 line-through mr-1">{formatEgp(item.unit_price * item.quantity)}</span>
                      )}
                      <span className="font-semibold text-slate-900">{formatEgp(item.lineTotal)}</span>
                    </div>
                  </div>
                  {hasPermission('products.modify_price') && (
                    <div className="flex gap-2 mt-2">
                      <select
                        value={item.discount_type || 'none'}
                        onChange={(e) => {
                          const type = e.target.value === 'none' ? null : e.target.value as 'percentage' | 'fixed';
                          setItemDiscount(cartItemKey(item.product_id, item.variant_id), type, type ? item.discount_value : 0);
                        }}
                        className="text-xs border border-slate-200 rounded px-1.5 py-1 bg-white"
                      >
                        <option value="none">No Discount</option>
                        <option value="percentage">Discount %</option>
                        <option value="fixed">Discount EGP</option>
                      </select>
                      {item.discount_type && (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={item.discount_value || ''}
                          onChange={(e) => setItemDiscount(cartItemKey(item.product_id, item.variant_id), item.discount_type, parseLocalizedNumber(e.target.value) || 0)}
                          placeholder={item.discount_type === 'percentage' ? '%' : 'EGP'}
                          className="w-20 text-xs border border-slate-200 rounded px-2 py-1"
                        />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cart Summary */}
        {cart.length > 0 && (
          <div className="border-t border-slate-200 p-5 space-y-3 bg-slate-50">
            {hasPermission('products.modify_price') && (
              <div className="flex gap-2 items-center">
                <select
                  value={globalDiscountType}
                  onChange={(e) => setGlobalDiscountType(e.target.value as 'percentage' | 'fixed' | 'none')}
                  className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 bg-white"
                >
                  <option value="none">No Discount</option>
                  <option value="percentage">Discount %</option>
                  <option value="fixed">Discount EGP</option>
                </select>
                {globalDiscountType !== 'none' && (
                  <input
                    type="text"
                    inputMode="decimal"
                    value={globalDiscountValue}
                    onChange={(e) => setGlobalDiscountValue(e.target.value)}
                    placeholder={globalDiscountType === 'percentage' ? '%' : 'EGP'}
                    className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-1.5"
                  />
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <div className="flex justify-between text-sm text-slate-600">
                <span>Subtotal</span>
                <span>{formatEgp(subtotal)}</span>
              </div>
              {totalDiscount > 0 && (
                <div className="flex justify-between text-sm text-red-600">
                  <span>Discount</span>
                  <span>-{formatEgp(totalDiscount)}</span>
                </div>
              )}
              <div className="flex justify-between text-xl font-bold text-slate-900 pt-2 border-t border-slate-200">
                <span>Total</span>
                <span>{formatEgp(total)}</span>
              </div>
            </div>
            <Button size="lg" className="w-full" onClick={() => setShowPaymentModal(true)}>
              <CreditCard size={20} /> Charge {formatEgp(total)}
            </Button>
          </div>
        )}
      </div>

      {/* A variant is its own sellable inventory record. */}
      <Modal
        open={variantProduct !== null}
        onClose={() => { setVariantProduct(null); setVariantChoices([]); }}
        title={variantProduct ? `Select variant — ${variantProduct.name}` : 'Select variant'}
        size="md"
      >
        <div className="grid grid-cols-2 gap-3">
          {variantChoices.map((variant) => {
            const label = [variant.color, variant.size].filter(Boolean).join(' / ');
            const price = variant.selling_price ?? variantProduct?.selling_price ?? 0;
            return (
              <button
                key={variant.id}
                disabled={!allowNegativeStock && variant.quantity <= 0}
                onClick={() => {
                  if (variantProduct) addToCart(variantProduct, variant);
                  setVariantProduct(null);
                  setVariantChoices([]);
                  setSearch('');
                  setSearchResults([]);
                }}
                className="rounded-lg border border-slate-200 p-3 text-left transition-colors hover:border-teal-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <p className="font-medium text-slate-900">{label || 'Default variant'}</p>
                <p className="mt-1 text-sm font-semibold text-slate-700">{formatEgp(price)}</p>
                <p className="mt-1 text-xs text-slate-500">Stock: {formatQuantity(variant.quantity)}</p>
              </button>
            );
          })}
        </div>
      </Modal>

      {/* Payment Modal */}
      <Modal
        open={showPaymentModal}
        onClose={() => setShowPaymentModal(false)}
        title="Complete Payment"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowPaymentModal(false)}>Cancel</Button>
            <Button variant="success" onClick={completeSale} disabled={isCompletingSale}>
              <Check size={18} /> {isCompletingSale ? 'Processing…' : 'Complete Sale'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="text-center py-4 bg-slate-50 rounded-xl">
            <p className="text-sm text-slate-500">Total Amount Due</p>
            <p className="text-3xl font-bold text-slate-900 mt-1">{formatEgp(total)}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Payment Method</label>
            <div className="grid grid-cols-2 gap-2">
              {paymentMethods.map((method) => (
                <button
                  key={method}
                  onClick={() => setPaymentMethod(method)}
                  className={`flex items-center gap-2 p-3 rounded-lg border-2 transition-all ${
                    paymentMethod === method
                      ? 'border-teal-500 bg-teal-50 text-teal-700'
                      : 'border-slate-200 hover:border-slate-300 text-slate-700'
                  }`}
                >
                  {paymentIcons[method] || <Wallet size={18} />}
                  <span className="text-sm font-medium">{method}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* Receipt Modal */}
      {completedSale && (
        <Receipt saleId={completedSale.id} onClose={() => setCompletedSale(null)} />
      )}
    </div>
  );
}
