import { type ReactNode } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { usePosSessions } from '@/context/PosSessionsContext';
import { Button } from '@/components/ui/Button';
import { LanguageToggle } from '@/components/LanguageToggle';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Boxes,
  Receipt,
  Users,
  Undo2,
  Wallet,
  BarChart3,
  TrendingUp,
  UserCog,
  DatabaseBackup,
  Settings as SettingsIcon,
  LogOut,
  Store,
} from 'lucide-react';

export type PageKey =
  | 'dashboard'
  | 'pos'
  | 'products'
  | 'inventory'
  | 'invoices'
  | 'customers'
  | 'refunds'
  | 'expenses'
  | 'reports'
  | 'employee-performance'
  | 'users'
  | 'backup'
  | 'settings';

interface NavItem {
  key: PageKey;
  label: 'Dashboard' | 'POS / Sales' | 'Products' | 'Inventory' | 'Invoices' | 'Customers' | 'Refunds' | 'Expenses' | 'Reports' | 'Employee Performance' | 'Users' | 'Backup & Restore' | 'Settings';
  icon: ReactNode;
  permission: string;
  altPermission?: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={20} />, permission: 'dashboard' },
  { key: 'pos', label: 'POS / Sales', icon: <ShoppingCart size={20} />, permission: 'pos' },
  { key: 'products', label: 'Products', icon: <Package size={20} />, permission: 'products', altPermission: 'products.add' },
  { key: 'inventory', label: 'Inventory', icon: <Boxes size={20} />, permission: 'inventory' },
  { key: 'invoices', label: 'Invoices', icon: <Receipt size={20} />, permission: 'invoices' },
  { key: 'customers', label: 'Customers', icon: <Users size={20} />, permission: 'customers' },
  { key: 'refunds', label: 'Refunds', icon: <Undo2 size={20} />, permission: 'refunds' },
  { key: 'expenses', label: 'Expenses', icon: <Wallet size={20} />, permission: 'expenses' },
  { key: 'reports', label: 'Reports', icon: <BarChart3 size={20} />, permission: 'reports' },
  { key: 'employee-performance', label: 'Employee Performance', icon: <TrendingUp size={20} />, permission: 'employee_performance' },
  { key: 'users', label: 'Users', icon: <UserCog size={20} />, permission: 'users' },
  { key: 'backup', label: 'Backup & Restore', icon: <DatabaseBackup size={20} />, permission: 'backup' },
  { key: 'settings', label: 'Settings', icon: <SettingsIcon size={20} />, permission: 'settings' },
];

interface LayoutProps {
  current: PageKey;
  onNavigate: (page: PageKey) => void;
  children: ReactNode;
}

export function Layout({ current, onNavigate, children }: LayoutProps) {
  const { user, logout, hasPermission } = useAuth();
  const { t, isArabic } = useLanguage();
  const { tabs: saleTabs } = usePosSessions();
  const openSales = saleTabs.filter((tab) => tab.cart.length > 0).length;

  const visibleItems = NAV_ITEMS.filter((item) => hasPermission(item.permission) || (item.altPermission && hasPermission(item.altPermission)));

  return (
    <div className={`flex h-screen bg-slate-50 ${isArabic ? 'flex-row-reverse' : ''}`}>
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col flex-shrink-0">
        <div className="px-5 py-5 flex items-center gap-3 border-b border-slate-800">
          <div className="w-10 h-10 rounded-xl bg-teal-500/10 border border-teal-400/20 flex items-center justify-center flex-shrink-0">
            <Store className="text-teal-400" size={22} />
          </div>
          <div className="min-w-0">
            <h1 className="text-white font-bold text-lg tracking-tight">ELAKRAMMEN</h1>
            <p className="text-xs text-slate-500">{t('POS System')}</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto scrollbar-thin py-4 px-3 space-y-1">
          {visibleItems.map((item) => (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                current === item.key
                  ? 'bg-teal-500/10 text-teal-400 border border-teal-400/20'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              {item.icon}
              {t(item.label)}
              {item.key === 'pos' && openSales > 0 && (
                <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-teal-500 px-1.5 text-[11px] font-bold text-white" title="Open sales">
                  {openSales}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="border-t border-slate-800 p-3">
          <div className="flex items-center gap-3 px-3 py-2 mb-2">
            <div className="w-9 h-9 rounded-full bg-slate-700 flex items-center justify-center text-sm font-semibold text-white flex-shrink-0">
              {user?.display_name?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-white truncate">{user?.display_name}</p>
              <p className="text-xs text-slate-500 capitalize">{user?.role_name}</p>
            </div>
          </div>
          <LanguageToggle className="mb-2 w-full justify-center border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700" />
          <Button variant="ghost" size="sm" onClick={logout} className="w-full text-slate-400 hover:text-white hover:bg-slate-800">
            <LogOut size={16} />
            {t('Sign Out')}
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[1400px] mx-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}

export { NAV_ITEMS };
