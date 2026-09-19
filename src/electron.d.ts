// Type declarations for the Electron preload bridge.

export interface TxStep {
  type: 'query' | 'exec';
  sql: string;
  params?: unknown[];
}

export interface BackupInfo {
  name: string;
  path: string;
  size: number;
  date: string;
}

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

export interface ElectronAPI {
  auth: {
    login: (username: string, password: string) => Promise<{ success: boolean; error?: string; user?: AuthUser; sessionId?: number }>;
    changeInitialPassword: (sessionId: number, password: string) => Promise<{ success: boolean; error?: string }>;
    logout: (sessionId: number) => Promise<{ success: boolean; error?: string }>;
    restore: (previousSessionId: number) => Promise<{ success: boolean; sessionId?: number; user?: AuthUser }>;
    hasPermission: (sessionId: number, perm: string) => Promise<{ success: boolean; result: boolean }>;
    hashPassword: (sessionId: number, password: string) => Promise<{ success: boolean; hash?: string; salt?: string; error?: string }>;
  };
  db: {
    completeSale: (request: {
      customerId: number | null;
      paymentMethod: string;
      globalDiscount: { type: 'percentage' | 'fixed' | 'none'; value: number };
      items: Array<{ productId: number; variantId: number | null; quantity: number; discountType: 'percentage' | 'fixed' | null; discountValue: number }>;
    }, sessionId?: number) => Promise<{ success: boolean; sale?: { id: number; invoice_number: string; subtotal: number; discount_amount: number; total: number; customer_id: number | null; cashier_id: number; payment_method: string; status: string; notes: null; created_at: string }; error?: string }>;
    processRefund: (request: {
      saleId: number;
      reason: string;
      items: Array<{ saleItemId: number; quantity: number }>;
    }, sessionId?: number) => Promise<{ success: boolean; refund?: { id: number; refund_number: string; total: number }; error?: string }>;
    query: (sql: string, params?: unknown[], sessionId?: number) => Promise<{ success: boolean; rows?: Record<string, unknown>[]; error?: string }>;
    exec: (sql: string, params?: unknown[], sessionId?: number) => Promise<{ success: boolean; changes?: number; lastInsertRowid?: number | bigint; error?: string }>;
    runTransaction: (steps: TxStep[], sessionId?: number) => Promise<{ success: boolean; results?: unknown[]; error?: string }>;
    txBegin: (sessionId?: number) => Promise<{ success: boolean; sessionId?: number; error?: string }>;
    txQuery: (txId: number, sql: string, params?: unknown[]) => Promise<{ success: boolean; rows?: Record<string, unknown>[]; error?: string }>;
    txExec: (txId: number, sql: string, params?: unknown[]) => Promise<{ success: boolean; changes?: number; lastInsertRowid?: number | bigint; error?: string }>;
    txCommit: (txId: number) => Promise<{ success: boolean; error?: string }>;
    txRollback: (txId: number) => Promise<{ success: boolean; error?: string }>;
    backup: (label?: string, sessionId?: number) => Promise<{ success: boolean; path?: string; error?: string }>;
    restore: (backupPath: string, sessionId?: number) => Promise<{ success: boolean; error?: string }>;
    listBackups: (sessionId?: number) => Promise<{ success: boolean; backups?: BackupInfo[]; error?: string }>;
    deleteBackup: (backupPath: string, sessionId?: number) => Promise<{ success: boolean; error?: string }>;
    saveBackupTo: (sessionId?: number) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>;
    getInfo: (sessionId?: number) => Promise<{ success: boolean; path?: string; backupDir?: string; error?: string }>;
    createProduct: (product: {
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
    }, sessionId?: number) => Promise<{ success: boolean; productId?: number; error?: string }>;
    saveProductWithVariants: (payload: {
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
      variants: Array<{ color: string; size: string; quantity: number; is_active: boolean }>;
    }, sessionId?: number) => Promise<{ success: boolean; productId?: number; error?: string }>;
    saveProductWithVariants: (payload: {
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
      variants: Array<{ color: string; size: string; quantity: number; is_active: boolean }>;
    }, sessionId?: number) => Promise<{ success: boolean; productId?: number; error?: string }>;
    deleteProduct: (productId: number, sessionId?: number) => Promise<{ success: boolean; error?: string }>;
    deleteUser: (userId: number, sessionId?: number) => Promise<{ success: boolean; error?: string }>;
  };
  print: {
    print: (
      html: string,
      options?: { silent?: boolean; printerName?: string; pageSize?: { width: number; height: number }; margins?: { marginType: 'none' | 'custom'; top?: number; bottom?: number; left?: number; right?: number } },
      sessionId?: number,
    ) => Promise<{ success: boolean; error?: string }>;
    getPrinters: (sessionId?: number) => Promise<{ success: boolean; printers?: { name: string; displayName: string; isDefault: boolean; status: number }[]; error?: string }>;
  };
  system: {
    info: (sessionId?: number) => Promise<{ success: boolean; info?: { platform: string; arch: string; hostname: string; userInfo: string }; error?: string }>;
  };
  isElectron: boolean;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
