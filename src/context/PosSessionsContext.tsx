import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef,
  type ReactNode,
} from 'react';
import { query } from '@/db/client';
import { useAuth } from '@/context/AuthContext';
import { toast } from '@/components/ui/Toast';
import type { CartItem, Sale } from '@/types';

// ─────────────────────────────────────────────────────────────
// Multiple simultaneous sale tabs.
//
// Every open sale lives in this store instead of inside the POS page, so:
//   • switching tabs never copies/“captures” anything — each tab is its own
//     record and cannot leak into another one;
//   • leaving the POS page (Products, Invoices, …) does not lose any cart;
//   • an in-flight “Complete sale” always finishes into the tab that started
//     it, even if the cashier has switched to another tab meanwhile;
//   • drafts survive an app restart (per user), so a crash or accidental close
//     does not lose carts.
//
// The real stock check + invoice numbering still happen atomically in the main
// process (`sales:complete`), so two tabs can never oversell or share an
// invoice number even if they finish at the same moment.
// ─────────────────────────────────────────────────────────────

export type DiscountType = 'percentage' | 'fixed' | 'none';

export interface SaleTab {
  id: number;
  /** Stable display number (“Sale 3”). Never re-assigned when other tabs close. */
  number: number;
  search: string;
  cart: CartItem[];
  customerId: string;
  paymentMethod: string;
  showPaymentModal: boolean;
  isCompletingSale: boolean;
  /** True when the app was closed while this sale was being completed. */
  interrupted: boolean;
  completedSale: Sale | null;
  globalDiscountType: DiscountType;
  globalDiscountValue: string;
}

interface StoreState {
  userId: number | null;
  tabs: SaleTab[];
  activeId: number;
  nextNumber: number;
}

export const cartItemKey = (productId: number, variantId: number | null) =>
  `${productId}:${variantId ?? 'product'}`;

let tabIdCounter = 1;

function createTab(number: number, overrides: Partial<SaleTab> = {}): SaleTab {
  return {
    id: tabIdCounter++,
    number,
    search: '',
    cart: [],
    customerId: '',
    paymentMethod: 'Cash',
    showPaymentModal: false,
    isCompletingSale: false,
    interrupted: false,
    completedSale: null,
    globalDiscountType: 'none',
    globalDiscountValue: '',
    ...overrides,
  };
}

// ─── Persistence ───────────────────────────────────────────

const STORAGE_PREFIX = 'elakrammen_pos_drafts_v1:';
const MAX_DRAFT_AGE_MS = 24 * 60 * 60 * 1000;

interface PersistedTab {
  number: number;
  cart: CartItem[];
  customerId: string;
  paymentMethod: string;
  globalDiscountType: DiscountType;
  globalDiscountValue: string;
  /** The sale was mid-flight when this snapshot was written. */
  completing: boolean;
}

interface PersistedState {
  savedAt: number;
  activeIndex: number;
  nextNumber: number;
  tabs: PersistedTab[];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeCartItem(raw: unknown): CartItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const productId = finiteNumber(r.product_id);
  const quantity = finiteNumber(r.quantity);
  const unitPrice = finiteNumber(r.unit_price);
  if (productId === null || quantity === null || quantity <= 0 || unitPrice === null) return null;
  const variantId = r.variant_id === null || r.variant_id === undefined ? null : finiteNumber(r.variant_id);
  if (r.variant_id !== null && r.variant_id !== undefined && variantId === null) return null;
  return {
    product_id: productId,
    variant_id: variantId,
    variant_label: typeof r.variant_label === 'string' ? r.variant_label : null,
    name: typeof r.name === 'string' ? r.name : 'Item',
    barcode: typeof r.barcode === 'string' ? r.barcode : null,
    unit_price: unitPrice,
    quantity,
    discount_type: r.discount_type === 'percentage' || r.discount_type === 'fixed' ? r.discount_type : null,
    discount_value: finiteNumber(r.discount_value) ?? 0,
    available_stock: finiteNumber(r.available_stock) ?? 0,
    cost: finiteNumber(r.cost) ?? 0,
  };
}

function freshState(userId: number | null): StoreState {
  const tab = createTab(1);
  return { userId, tabs: [tab], activeId: tab.id, nextNumber: 2 };
}

function loadState(userId: number | null): StoreState {
  if (userId === null) return freshState(userId);
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + userId);
    if (!raw) return freshState(userId);
    const saved = JSON.parse(raw) as PersistedState;
    if (!saved || !Array.isArray(saved.tabs) || typeof saved.savedAt !== 'number') return freshState(userId);
    if (Date.now() - saved.savedAt > MAX_DRAFT_AGE_MS) return freshState(userId);

    const tabs: SaleTab[] = [];
    for (const persisted of saved.tabs) {
      if (!persisted || !Array.isArray(persisted.cart)) continue;
      const cart = persisted.cart.map(sanitizeCartItem).filter((item): item is CartItem => item !== null);
      const number = finiteNumber(persisted.number) ?? tabs.length + 1;
      tabs.push(createTab(number, {
        cart,
        customerId: typeof persisted.customerId === 'string' ? persisted.customerId : '',
        paymentMethod: typeof persisted.paymentMethod === 'string' ? persisted.paymentMethod : 'Cash',
        globalDiscountType: ['percentage', 'fixed', 'none'].includes(persisted.globalDiscountType) ? persisted.globalDiscountType : 'none',
        globalDiscountValue: typeof persisted.globalDiscountValue === 'string' ? persisted.globalDiscountValue : '',
        interrupted: persisted.completing === true && cart.length > 0,
      }));
    }
    if (tabs.length === 0) return freshState(userId);
    const activeIndex = Math.min(Math.max(0, Math.floor(finiteNumber(saved.activeIndex) ?? 0)), tabs.length - 1);
    const nextNumber = Math.max(finiteNumber(saved.nextNumber) ?? 1, ...tabs.map((tab) => tab.number + 1));
    return { userId, tabs, activeId: tabs[activeIndex].id, nextNumber };
  } catch {
    return freshState(userId);
  }
}

function persistState(state: StoreState): void {
  if (state.userId === null) return;
  const key = STORAGE_PREFIX + state.userId;
  try {
    const hasContent = state.tabs.some((tab) => tab.cart.length > 0);
    if (!hasContent && state.tabs.length <= 1) {
      localStorage.removeItem(key);
      return;
    }
    const payload: PersistedState = {
      savedAt: Date.now(),
      activeIndex: Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeId)),
      nextNumber: state.nextNumber,
      tabs: state.tabs.map((tab) => ({
        number: tab.number,
        cart: tab.cart,
        customerId: tab.customerId,
        paymentMethod: tab.paymentMethod,
        globalDiscountType: tab.globalDiscountType,
        globalDiscountValue: tab.globalDiscountValue,
        completing: tab.isCompletingSale || tab.interrupted,
      })),
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Storage can be full or unavailable; the in-memory tabs keep working.
  }
}

// ─── Context ───────────────────────────────────────────────

type TabPatch = Partial<SaleTab> | ((tab: SaleTab) => Partial<SaleTab>);

interface FreshItemData {
  price: number;
  stock: number;
  active: boolean;
}

interface PosSessionsValue {
  tabs: SaleTab[];
  activeId: number;
  getTab: (id: number) => SaleTab | undefined;
  getActiveId: () => number;
  updateTab: (id: number, patch: TabPatch) => void;
  addTab: () => number;
  switchTab: (id: number) => void;
  /** Returns false when the tab cannot be closed (a sale is being processed). */
  closeTab: (id: number) => boolean;
  /** Quantity of a product/variant that sits in the carts of the OTHER tabs. */
  reservedByOthers: (tabId: number, key: string) => number;
  /** Re-reads live stock + price for the items in the given tabs (all tabs by default). */
  refreshStock: (tabIds?: number[]) => Promise<void>;
}

const PosSessionsContext = createContext<PosSessionsValue | null>(null);

async function fetchFreshItem(item: CartItem): Promise<FreshItemData | 'missing' | undefined> {
  try {
    if (item.variant_id === null) {
      const res = await query<{ selling_price: number; quantity: number; is_active: number }>(
        'SELECT selling_price, quantity, is_active FROM products WHERE id = $1',
        [item.product_id],
      );
      const row = res.rows[0];
      if (!row) return 'missing';
      return { price: Number(row.selling_price), stock: Number(row.quantity), active: Number(row.is_active) === 1 };
    }
    const res = await query<{ selling_price: number; quantity: number; is_active: number; product_active: number }>(
      `SELECT COALESCE(pv.selling_price, p.selling_price) AS selling_price,
              pv.quantity AS quantity, pv.is_active AS is_active, p.is_active AS product_active
         FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
        WHERE pv.id = $1 AND pv.product_id = $2`,
      [item.variant_id, item.product_id],
    );
    const row = res.rows[0];
    if (!row) return 'missing';
    return {
      price: Number(row.selling_price),
      stock: Number(row.quantity),
      active: Number(row.is_active) === 1 && Number(row.product_active) === 1,
    };
  } catch {
    // A failed lookup must never wipe or alter the cart.
    return undefined;
  }
}

export function PosSessionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const stateRef = useRef<StoreState | null>(null);
  const [version, rerender] = useReducer((n: number) => n + 1, 0);
  const saveTimer = useRef<number | undefined>(undefined);

  // Switching users swaps the whole store (each user has their own drafts).
  if (stateRef.current === null || stateRef.current.userId !== userId) {
    if (stateRef.current) persistState(stateRef.current);
    stateRef.current = loadState(userId);
  }

  const flushSave = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    if (stateRef.current) persistState(stateRef.current);
  }, []);

  const commit = useCallback((recipe: (state: StoreState) => StoreState, flush = false) => {
    const current = stateRef.current!;
    const next = recipe(current);
    if (next === current) return;
    stateRef.current = next;
    if (flush) {
      flushSave();
    } else {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flushSave, 300);
    }
    rerender();
  }, [flushSave]);

  useEffect(() => {
    window.addEventListener('beforeunload', flushSave);
    return () => {
      window.removeEventListener('beforeunload', flushSave);
      flushSave();
    };
  }, [flushSave]);

  const getTab = useCallback((id: number) => stateRef.current?.tabs.find((tab) => tab.id === id), []);
  const getActiveId = useCallback(() => stateRef.current!.activeId, []);

  const updateTab = useCallback((id: number, patch: TabPatch) => {
    commit((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return state; // The tab was closed while an async task was running.
      const changes = typeof patch === 'function' ? patch(state.tabs[index]) : patch;
      const tabs = state.tabs.slice();
      tabs[index] = { ...state.tabs[index], ...changes };
      return { ...state, tabs };
    }, 'isCompletingSale' in (typeof patch === 'function' ? {} : patch));
  }, [commit]);

  const addTab = useCallback(() => {
    let createdId = 0;
    commit((state) => {
      const tab = createTab(state.nextNumber);
      createdId = tab.id;
      return { ...state, tabs: [...state.tabs, tab], activeId: tab.id, nextNumber: state.nextNumber + 1 };
    });
    return createdId;
  }, [commit]);

  const switchTab = useCallback((id: number) => {
    commit((state) => (state.activeId === id || !state.tabs.some((tab) => tab.id === id) ? state : { ...state, activeId: id }));
  }, [commit]);

  const closeTab = useCallback((id: number) => {
    const target = stateRef.current?.tabs.find((tab) => tab.id === id);
    if (!target || target.isCompletingSale) return false;
    commit((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return state;
      if (state.tabs.length === 1) {
        const tab = createTab(state.nextNumber);
        return { ...state, tabs: [tab], activeId: tab.id, nextNumber: state.nextNumber + 1 };
      }
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      let activeId = state.activeId;
      if (activeId === id) activeId = tabs[Math.min(index, tabs.length - 1)].id;
      return { ...state, tabs, activeId };
    }, true);
    return true;
  }, [commit]);

  const reservedByOthers = useCallback((tabId: number, key: string) => {
    let total = 0;
    for (const tab of stateRef.current?.tabs ?? []) {
      if (tab.id === tabId) continue;
      for (const item of tab.cart) {
        if (cartItemKey(item.product_id, item.variant_id) === key) total += item.quantity;
      }
    }
    return total;
  }, []);

  const refreshStock = useCallback(async (tabIds?: number[]) => {
    const snapshot = stateRef.current;
    if (!snapshot) return;
    const targets = snapshot.tabs.filter((tab) => tab.cart.length > 0 && (!tabIds || tabIds.includes(tab.id)));
    if (targets.length === 0) return;
    const ownerUserId = snapshot.userId;

    // One lookup per distinct product/variant, shared by every tab.
    const lookups = new Map<string, Promise<FreshItemData | 'missing' | undefined>>();
    for (const tab of targets) {
      for (const item of tab.cart) {
        const key = cartItemKey(item.product_id, item.variant_id);
        if (!lookups.has(key)) lookups.set(key, fetchFreshItem(item));
      }
    }
    const results = new Map<string, FreshItemData | 'missing' | undefined>();
    await Promise.all([...lookups.entries()].map(async ([key, promise]) => { results.set(key, await promise); }));

    const targetIds = new Set(targets.map((tab) => tab.id));
    const priceChanged: string[] = [];
    const unavailable: string[] = [];
    commit((state) => {
      if (state.userId !== ownerUserId) return state;
      let changed = false;
      const tabs = state.tabs.map((tab) => {
        if (!targetIds.has(tab.id)) return tab;
        let tabChanged = false;
        const cart = tab.cart.map((item) => {
          const fresh = results.get(cartItemKey(item.product_id, item.variant_id));
          if (fresh === undefined) return item;
          if (fresh === 'missing' || !fresh.active) {
            if (item.available_stock === 0) return item;
            tabChanged = true;
            if (tab.id === state.activeId) unavailable.push(item.name);
            return { ...item, available_stock: 0 };
          }
          if (fresh.price === item.unit_price && fresh.stock === item.available_stock) return item;
          tabChanged = true;
          if (fresh.price !== item.unit_price && tab.id === state.activeId) priceChanged.push(item.name);
          return { ...item, unit_price: fresh.price, available_stock: fresh.stock };
        });
        if (!tabChanged) return tab;
        changed = true;
        return { ...tab, cart };
      });
      return changed ? { ...state, tabs } : state;
    });

    // Only speak up about the tab the cashier is looking at.
    for (const name of unavailable) toast('error', `${name} is no longer available`);
    for (const name of priceChanged) toast('info', `Price updated: ${name}`);
  }, [commit]);

  const value = useMemo<PosSessionsValue>(() => ({
    tabs: stateRef.current!.tabs,
    activeId: stateRef.current!.activeId,
    getTab,
    getActiveId,
    updateTab,
    addTab,
    switchTab,
    closeTab,
    reservedByOthers,
    refreshStock,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [version, userId, getTab, getActiveId, updateTab, addTab, switchTab, closeTab, reservedByOthers, refreshStock]);

  return <PosSessionsContext.Provider value={value}>{children}</PosSessionsContext.Provider>;
}

export function usePosSessions() {
  const context = useContext(PosSessionsContext);
  if (!context) throw new Error('usePosSessions must be used within PosSessionsProvider');
  return context;
}
