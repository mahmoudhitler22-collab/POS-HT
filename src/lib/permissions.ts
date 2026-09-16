// Permission definitions for ELAKRAMMEN POS
// Four business roles: Owner, Manager, Cashier, Inventory Employee

export type Permission =
  | 'dashboard'
  | 'pos'
  | 'products'
  | 'products.add'
  | 'products.view_cost'
  | 'products.modify_price'
  | 'inventory'
  | 'invoices'
  | 'refunds'
  | 'customers'
  | 'expenses'
  | 'reports'
  | 'profit'
  | 'employee_performance'
  | 'users'
  | 'settings'
  | 'backup'
  | 'audit';

export const ALL_PERMISSIONS: Permission[] = [
  'dashboard',
  'pos',
  'products',
  'products.add',
  'products.view_cost',
  'products.modify_price',
  'inventory',
  'invoices',
  'refunds',
  'customers',
  'expenses',
  'reports',
  'profit',
  'employee_performance',
  'users',
  'settings',
  'backup',
  'audit',
];

export type PermissionSet = Record<Permission, boolean>;

export const OWNER_PERMISSIONS: PermissionSet = ALL_PERMISSIONS.reduce(
  (acc, p) => ({ ...acc, [p]: true }),
  {} as PermissionSet
);

// Manager: Dashboard, POS, Inventory, Products, Brands, Categories, Barcode, Sales History, Customers
export const MANAGER_PERMISSIONS: PermissionSet = {
  dashboard: true,
  pos: true,
  products: true,
  'products.add': true,
  'products.view_cost': true,
  'products.modify_price': true,
  inventory: true,
  invoices: true,
  refunds: true,
  customers: true,
  expenses: false,
  reports: false,
  profit: false,
  employee_performance: false,
  users: false,
  settings: false,
  backup: false,
  audit: false,
};

// Cashier: POS only + returns/refunds
export const CASHIER_PERMISSIONS: PermissionSet = {
  dashboard: false,
  pos: true,
  products: false,
  'products.add': false,
  'products.view_cost': false,
  'products.modify_price': false,
  inventory: false,
  invoices: false,
  refunds: true,
  customers: false,
  expenses: false,
  reports: false,
  profit: false,
  employee_performance: false,
  users: false,
  settings: false,
  backup: false,
  audit: false,
};

// Inventory Employee: POS, Returns/Refunds, Add Products only
// No general inventory management, no price editing, no cost viewing, no reports
export const INVENTORY_PERMISSIONS: PermissionSet = {
  dashboard: false,
  pos: true,
  products: false,
  'products.add': true,
  'products.view_cost': false,
  'products.modify_price': false,
  inventory: false,
  invoices: false,
  refunds: true,
  customers: false,
  expenses: false,
  reports: false,
  profit: false,
  employee_performance: false,
  users: false,
  settings: false,
  backup: false,
  audit: false,
};

export const ROLE_PERMISSIONS: Record<string, PermissionSet> = {
  owner: OWNER_PERMISSIONS,
  manager: MANAGER_PERMISSIONS,
  cashier: CASHIER_PERMISSIONS,
  inventory: INVENTORY_PERMISSIONS,
};

export function getRolePermissions(roleName: string): PermissionSet {
  return ROLE_PERMISSIONS[roleName] || CASHIER_PERMISSIONS;
}

export function hasPermission(perms: PermissionSet, perm: Permission): boolean {
  return !!perms[perm];
}

export function parsePermissions(json: string): PermissionSet {
  const base = ALL_PERMISSIONS.reduce((acc, p) => ({ ...acc, [p]: false }), {} as PermissionSet);
  try {
    const parsed = JSON.parse(json);
    return { ...base, ...parsed };
  } catch {
    return base;
  }
}
