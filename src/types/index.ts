// Shared types for ELAKRAMMEN POS

export interface User {
  id: number;
  username: string;
  display_name: string;
  role_id: number;
  role_name?: string;
  is_active: number;
  permissions: PermissionSet;
  created_at: string;
  updated_at: string;
}

export type PermissionSet = Record<string, boolean>;

export interface Product {
  id: number;
  sku: string | null;
  barcode: string | null;
  name: string;
  brand_id: number | null;
  brand_name?: string | null;
  category_id: number | null;
  category_name?: string | null;
  type: string | null;
  size: string | null;
  color: string | null;
  purchase_cost?: number;
  selling_price: number;
  quantity: number;
  min_stock_level: number;
  supplier_id: number | null;
  notes: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface ProductVariant {
  id: number;
  product_id: number;
  size: string | null;
  color: string | null;
  barcode: string | null;
  purchase_cost: number | null;
  selling_price: number | null;
  quantity: number;
  min_stock_level: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: number;
  name: string;
}

export interface Brand {
  id: number;
  name: string;
}

export interface Supplier {
  id: number;
  name: string;
  phone: string | null;
  notes: string | null;
}

export interface Customer {
  id: number;
  name: string;
  phone: string | null;
  notes: string | null;
  total_purchases: number;
  purchase_count: number;
  yearly_purchases: number;
  last_purchase_date: string | null;
  loyalty_points: number;
  created_at: string;
}

export interface Sale {
  id: number;
  invoice_number: string;
  customer_id: number | null;
  customer_name?: string | null;
  cashier_id: number;
  cashier_name?: string;
  subtotal: number;
  discount_amount: number;
  total: number;
  payment_method: string;
  status: string;
  notes: string | null;
  created_at: string;
}

export interface SaleItem {
  id: number;
  sale_id: number;
  product_id: number;
  product_name: string;
  unit_price: number;
  quantity: number;
  discount_type: string | null;
  discount_value: number;
  discount_amount: number;
  final_price: number;
  cost_at_sale: number;
  line_total: number;
}

export interface Payment {
  id: number;
  sale_id: number;
  method: string;
  amount: number;
  created_at: string;
}

export interface Refund {
  id: number;
  refund_number: string;
  sale_id: number;
  customer_id: number | null;
  cashier_id: number;
  total: number;
  reason: string | null;
  created_at: string;
}

export interface RefundItem {
  id: number;
  refund_id: number;
  sale_item_id: number;
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price: number;
  refund_amount: number;
}

export interface Expense {
  id: number;
  category: string;
  amount: number;
  description: string | null;
  user_id: number;
  user_name?: string;
  created_at: string;
}

export interface InventoryMovement {
  id: number;
  product_id: number;
  product_name?: string;
  quantity_change: number;
  previous_quantity: number;
  new_quantity: number;
  reason: string;
  reference_type: string | null;
  reference_id: number | null;
  user_id: number;
  user_name?: string;
  created_at: string;
}

export interface AuditLog {
  id: number;
  user_id: number | null;
  user_name?: string;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  previous_value: string | null;
  new_value: string | null;
  created_at: string;
}

export interface Setting {
  key: string;
  value: string;
}

export interface CartItem {
  product_id: number;
  name: string;
  barcode: string | null;
  unit_price: number;
  quantity: number;
  discount_type: 'percentage' | 'fixed' | null;
  discount_value: number;
  available_stock: number;
  cost: number;
}
