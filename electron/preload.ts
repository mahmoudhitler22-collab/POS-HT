import { contextBridge, ipcRenderer } from 'electron';

export interface TxStep {
  type: 'query' | 'exec';
  sql: string;
  params?: unknown[];
}

export interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  role_id: number;
  role_name: string;
  is_active: number;
  permissions: Record<string, boolean>;
  created_at: string;
  updated_at: string;
}

const electronAPI = {
  // Authentication
  auth: {
    login: (username: string, password: string): Promise<{ success: boolean; error?: string; user?: AuthUser; sessionId?: number }> =>
      ipcRenderer.invoke('auth:login', username, password),
    logout: (sessionId: number): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('auth:logout', sessionId),
    restore: (previousSessionId: number): Promise<{ success: boolean; sessionId?: number; user?: AuthUser }> =>
      ipcRenderer.invoke('auth:restore', previousSessionId),
    hasPermission: (sessionId: number, perm: string): Promise<{ success: boolean; result: boolean }> =>
      ipcRenderer.invoke('auth:hasPermission', sessionId, perm),
    hashPassword: (sessionId: number, password: string): Promise<{ success: boolean; hash?: string; salt?: string; error?: string }> =>
      ipcRenderer.invoke('auth:hashPassword', sessionId, password),
  },

  // Database operations — all require sessionId for permission checks
  db: {
    // Business operations are deliberately narrow.  Do not use the generic
    // SQL bridge for operations that change sales, refunds, or stock.
    completeSale: (request: {
      customerId: number | null;
      paymentMethod: string;
      globalDiscount: { type: 'percentage' | 'fixed' | 'none'; value: number };
      items: Array<{ productId: number; quantity: number; discountType: 'percentage' | 'fixed' | null; discountValue: number }>;
    }, sessionId?: number): Promise<{ success: boolean; sale?: { id: number; invoice_number: string; subtotal: number; discount_amount: number; total: number; customer_id: number | null; cashier_id: number; payment_method: string; status: string; notes: null; created_at: string }; error?: string }> =>
      ipcRenderer.invoke('sales:complete', request, sessionId),
    processRefund: (request: {
      saleId: number;
      reason: string;
      items: Array<{ saleItemId: number; quantity: number }>;
    }, sessionId?: number): Promise<{ success: boolean; refund?: { id: number; refund_number: string; total: number }; error?: string }> =>
      ipcRenderer.invoke('refunds:process', request, sessionId),
    query: (sql: string, params?: unknown[], sessionId?: number): Promise<{ success: boolean; rows?: unknown[]; error?: string }> =>
      ipcRenderer.invoke('db:query', sql, params, sessionId),
    exec: (sql: string, params?: unknown[], sessionId?: number): Promise<{ success: boolean; changes?: number; lastInsertRowid?: number | bigint; error?: string }> =>
      ipcRenderer.invoke('db:exec', sql, params, sessionId),
    runTransaction: (steps: TxStep[], sessionId?: number): Promise<{ success: boolean; results?: unknown[]; error?: string }> =>
      ipcRenderer.invoke('db:runTransaction', steps, sessionId),
    txBegin: (sessionId?: number): Promise<{ success: boolean; sessionId?: number; error?: string }> =>
      ipcRenderer.invoke('db:txBegin', sessionId),
    txQuery: (txId: number, sql: string, params?: unknown[]): Promise<{ success: boolean; rows?: unknown[]; error?: string }> =>
      ipcRenderer.invoke('db:txQuery', txId, sql, params),
    txExec: (txId: number, sql: string, params?: unknown[]): Promise<{ success: boolean; changes?: number; lastInsertRowid?: number | bigint; error?: string }> =>
      ipcRenderer.invoke('db:txExec', txId, sql, params),
    txCommit: (txId: number): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('db:txCommit', txId),
    txRollback: (txId: number): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('db:txRollback', txId),
    backup: (label?: string, sessionId?: number): Promise<{ success: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('db:backup', label, sessionId),
    restore: (backupPath: string, sessionId?: number): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('db:restore', backupPath, sessionId),
    listBackups: (sessionId?: number): Promise<{ success: boolean; backups?: unknown[]; error?: string }> =>
      ipcRenderer.invoke('db:listBackups', sessionId),
    deleteBackup: (backupPath: string, sessionId?: number): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('db:deleteBackup', backupPath, sessionId),
    saveBackupTo: (sessionId?: number): Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }> =>
      ipcRenderer.invoke('db:saveBackupTo', sessionId),
    getInfo: (sessionId?: number): Promise<{ success: boolean; path?: string; backupDir?: string; error?: string }> =>
      ipcRenderer.invoke('db:getInfo', sessionId),
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
    }, sessionId?: number): Promise<{ success: boolean; productId?: number; error?: string }> =>
      ipcRenderer.invoke('db:createProduct', product, sessionId),
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
    }, sessionId?: number): Promise<{ success: boolean; productId?: number; error?: string }> =>
      ipcRenderer.invoke('db:saveProductWithVariants', payload, sessionId),
  },

  // Printing — requires sessionId
  print: {
    print: (
      html: string,
      options?: { silent?: boolean; printerName?: string; pageSize?: { width: number; height: number }; margins?: { marginType: 'none' | 'custom'; top?: number; bottom?: number; left?: number; right?: number } },
      sessionId?: number,
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('print:print', html, options, sessionId),
    getPrinters: (sessionId?: number): Promise<{ success: boolean; printers?: { name: string; displayName: string; isDefault: boolean; status: number }[]; error?: string }> =>
      ipcRenderer.invoke('print:getPrinters', sessionId),
  },

  // System info — requires sessionId
  system: {
    info: (sessionId?: number): Promise<{ success: boolean; info?: { platform: string; arch: string; hostname: string; userInfo: string }; error?: string }> =>
      ipcRenderer.invoke('system:info', sessionId),
  },

  isElectron: true,
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
