import { useState, useEffect, useCallback } from 'react';
import { query, execute } from '@/db/client';
import { useSettings } from '@/context/SettingsContext';
import { logAudit } from '@/lib/audit';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useAuth } from '@/context/AuthContext';
import { normalizeLocalizedNumber } from '@/lib/money';
import { normalizeSocialUrl } from '@/lib/print';
import {
  Settings as SettingsIcon, Store, CreditCard, Star, Save, Plus, X, Percent, Share2
} from 'lucide-react';

export function SettingsPage() {
  const { user } = useAuth();
  const { refresh } = useSettings();
  const [storeName, setStoreName] = useState('');
  const [storeAddress, setStoreAddress] = useState('');
  const [storePhone, setStorePhone] = useState('');
  const [currencySymbol, setCurrencySymbol] = useState('');
  const [allowNegativeStock, setAllowNegativeStock] = useState(false);
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false);
  const [loyaltyPointsPer1000, setLoyaltyPointsPer1000] = useState('10');
  const [receiptFooter, setReceiptFooter] = useState('');
  const [facebookName, setFacebookName] = useState('');
  const [facebookUrl, setFacebookUrl] = useState('');
  const [instagramName, setInstagramName] = useState('');
  const [tiktokName, setTiktokName] = useState('');
  const [invoicePrefix, setInvoicePrefix] = useState('INV');
  const [paymentMethods, setPaymentMethods] = useState<string[]>(['Cash', 'Card / Visa', 'Instapay', 'Other']);
  const [newPaymentMethod, setNewPaymentMethod] = useState('');
  const [maxDiscountPct, setMaxDiscountPct] = useState('20');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await query<{ key: string; value: string }>('SELECT key, value FROM settings');
    const map: Record<string, string> = {};
    for (const row of res.rows) map[row.key] = row.value;
    setStoreName(map.store_name || '');
    setStoreAddress(map.store_address || '');
    setStorePhone(map.store_phone || '');
    setCurrencySymbol(map.currency_symbol || 'E£');
    setAllowNegativeStock(map.allow_negative_stock === '1');
    setLoyaltyEnabled(map.loyalty_enabled === '1');
    setLoyaltyPointsPer1000(map.loyalty_points_per_1000_egp || '10');
    setReceiptFooter(map.receipt_footer || '');
    setFacebookName(map.social_facebook_name || '');
    setFacebookUrl(map.social_facebook_url || '');
    setInstagramName(map.social_instagram_name || '');
    setTiktokName(map.social_tiktok_name || '');
    setInvoicePrefix(map.invoice_prefix || 'INV');
    setMaxDiscountPct(map.max_discount_percentage || '20');
    try { setPaymentMethods(JSON.parse(map.payment_methods || '["Cash","Card / Visa","Instapay","Other"]')); } catch { /* keep default */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const normalizedFacebookUrl = normalizeSocialUrl(facebookUrl);
    if (normalizedFacebookUrl === null) {
      toast('error', 'Facebook page link is not valid');
      return;
    }
    setSaving(true);
    const updates: Record<string, string> = {
      store_name: storeName,
      store_address: storeAddress,
      store_phone: storePhone,
      currency_symbol: currencySymbol,
      allow_negative_stock: allowNegativeStock ? '1' : '0',
      loyalty_enabled: loyaltyEnabled ? '1' : '0',
      loyalty_points_per_1000_egp: normalizeLocalizedNumber(loyaltyPointsPer1000),
      receipt_footer: receiptFooter,
      social_facebook_name: facebookName.trim(),
      social_facebook_url: normalizedFacebookUrl,
      social_instagram_name: instagramName.trim(),
      social_tiktok_name: tiktokName.trim(),
      invoice_prefix: invoicePrefix,
      payment_methods: JSON.stringify(paymentMethods),
      max_discount_percentage: normalizeLocalizedNumber(maxDiscountPct),
    };

    try {
      for (const [key, value] of Object.entries(updates)) {
        await execute(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = datetime('now')`,
          [key, value]
        );
      }

      await logAudit({ user_id: user?.id ?? null, action: 'settings_update', entity_type: 'settings', new_value: JSON.stringify(updates) });
      await refresh();
      toast('success', 'Settings saved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save settings';
      toast('error', message);
    } finally {
      setSaving(false);
    }
  };

  const addPaymentMethod = () => {
    if (newPaymentMethod.trim() && !paymentMethods.includes(newPaymentMethod.trim())) {
      setPaymentMethods([...paymentMethods, newPaymentMethod.trim()]);
      setNewPaymentMethod('');
    }
  };

  const removePaymentMethod = (method: string) => {
    setPaymentMethods(paymentMethods.filter((m) => m !== method));
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500 mt-0.5">Configure your store and system preferences</p>
      </div>

      {/* Store Info */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-4">
          <Store size={20} className="text-slate-600" />
          <h3 className="font-semibold text-slate-900">Store Information</h3>
        </div>
        <div className="space-y-4">
          <Input label="Store Name" value={storeName} onChange={(e) => setStoreName(e.target.value)} />
          <Input label="Store Address" value={storeAddress} onChange={(e) => setStoreAddress(e.target.value)} />
          <Input label="Store Phone" value={storePhone} onChange={(e) => setStorePhone(e.target.value)} />
          <Input label="Currency Symbol" value={currencySymbol} onChange={(e) => setCurrencySymbol(e.target.value)} />
          <Textarea label="Receipt Footer" rows={2} value={receiptFooter} onChange={(e) => setReceiptFooter(e.target.value)} />
          <Input label="Invoice Number Prefix" value={invoicePrefix} onChange={(e) => setInvoicePrefix(e.target.value)} />
        </div>
      </div>

      {/* Social media on the receipt */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-1">
          <Share2 size={20} className="text-slate-600" />
          <h3 className="font-semibold text-slate-900">Social Media on Receipt</h3>
        </div>
        <p className="text-xs text-slate-400 mb-4">Printed at the bottom of every receipt. Leave a field empty to hide it.</p>
        <div className="space-y-4">
          <Input label="Facebook Page Name" placeholder="e.g. Elakrammen Store" value={facebookName} onChange={(e) => setFacebookName(e.target.value)} />
          <Input label="Facebook Page Link (printed as a QR code)" placeholder="https://www.facebook.com/your.page" value={facebookUrl} onChange={(e) => setFacebookUrl(e.target.value)} />
          <Input label="Instagram Account Name" placeholder="e.g. @elakrammen" value={instagramName} onChange={(e) => setInstagramName(e.target.value)} />
          <Input label="TikTok Account Name" placeholder="e.g. @elakrammen" value={tiktokName} onChange={(e) => setTiktokName(e.target.value)} />
        </div>
      </div>

      {/* Payment Methods */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-4">
          <CreditCard size={20} className="text-slate-600" />
          <h3 className="font-semibold text-slate-900">Payment Methods</h3>
        </div>
        <div className="space-y-2 mb-4">
          {paymentMethods.map((m) => (
            <div key={m} className="flex items-center justify-between p-2.5 rounded-lg border border-slate-200">
              <span className="text-sm font-medium text-slate-700">{m}</span>
              <button onClick={() => removePaymentMethod(m)} className="p-1 text-slate-400 hover:text-red-500">
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Input placeholder="New payment method" value={newPaymentMethod} onChange={(e) => setNewPaymentMethod(e.target.value)} className="flex-1" />
          <Button variant="outline" onClick={addPaymentMethod}><Plus size={18} /> Add</Button>
        </div>
      </div>

      {/* Inventory & Sales Settings */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-4">
          <SettingsIcon size={20} className="text-slate-600" />
          <h3 className="font-semibold text-slate-900">Inventory & Sales</h3>
        </div>
        <label className="flex items-center gap-3 cursor-pointer mb-4">
          <input type="checkbox" checked={allowNegativeStock} onChange={(e) => setAllowNegativeStock(e.target.checked)} className="w-5 h-5 rounded" />
          <div>
            <p className="text-sm font-medium text-slate-700">Allow Negative Stock</p>
            <p className="text-xs text-slate-400">Allow selling more than available quantity (not recommended)</p>
          </div>
        </label>
        <div className="flex items-center gap-2">
          <Percent size={18} className="text-slate-500" />
          <Input
            label="Maximum Discount Percentage"
            type="number"
            min="0"
            max="100"
            value={maxDiscountPct}
            onChange={(e) => setMaxDiscountPct(e.target.value)}
            className="max-w-[200px]"
          />
        </div>
        <p className="text-xs text-slate-400 mt-1 ml-7">Users cannot apply a discount higher than this percentage. Enforced in business logic.</p>
      </div>

      {/* Loyalty */}
      <div className="card p-6">
        <div className="flex items-center gap-2 mb-4">
          <Star size={20} className="text-slate-600" />
          <h3 className="font-semibold text-slate-900">Loyalty Program</h3>
        </div>
        <label className="flex items-center gap-3 cursor-pointer mb-4">
          <input type="checkbox" checked={loyaltyEnabled} onChange={(e) => setLoyaltyEnabled(e.target.checked)} className="w-5 h-5 rounded" />
          <div>
            <p className="text-sm font-medium text-slate-700">Enable Loyalty Program</p>
            <p className="text-xs text-slate-400">Award points to customers based on purchases</p>
          </div>
        </label>
        {loyaltyEnabled && (
          <div className="bg-slate-50 rounded-lg p-4">
            <Input
              label="Points per EGP 1,000 spent"
              type="number"
              min="1"
              value={loyaltyPointsPer1000}
              onChange={(e) => setLoyaltyPointsPer1000(e.target.value)}
            />
            <p className="text-xs text-slate-500 mt-2">
              Customers earn points based on completed EGP 1,000 units in each purchase.
              For example, a purchase of EGP 2,500 with 10 points per EGP 1,000 earns 20 points.
              Refunds reverse the points from the original sale.
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button size="lg" onClick={save} disabled={saving}>
          <Save size={18} /> {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>
    </div>
  );
}
