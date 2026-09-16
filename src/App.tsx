import { useState } from 'react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { SettingsProvider } from '@/context/SettingsContext';
import { LanguageProvider, useLanguage } from '@/context/LanguageContext';
import { ToastContainer } from '@/components/ui/Toast';
import { Layout, type PageKey } from '@/components/Layout';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { PosPage } from '@/pages/PosPage';
import { ProductsPage } from '@/pages/ProductsPage';
import { InventoryPage } from '@/pages/InventoryPage';
import { InvoicesPage } from '@/pages/InvoicesPage';
import { CustomersPage } from '@/pages/CustomersPage';
import { RefundsPage } from '@/pages/RefundsPage';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { ReportsPage } from '@/pages/ReportsPage';
import { EmployeePerformancePage } from '@/pages/EmployeePerformancePage';
import { UsersPage } from '@/pages/UsersPage';
import { BackupPage } from '@/pages/BackupPage';
import { SettingsPage } from '@/pages/SettingsPage';

function AppContent() {
  const { user, loading, hasPermission } = useAuth();
  const { t } = useLanguage();
  const [currentPage, setCurrentPage] = useState<PageKey>('dashboard');

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="text-center">
          <div className="inline-block w-10 h-10 border-4 border-slate-700 border-t-teal-500 rounded-full animate-spin mb-4" />
          <p className="text-slate-400 text-sm">{t('Loading ELAKRAMMEN POS...')}</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  // If user lacks permission for the current page, redirect to first available
  const ensurePage = (page: PageKey): PageKey => {
    const pagePermissions: Record<PageKey, string> = {
      dashboard: 'dashboard',
      pos: 'pos',
      products: 'products',
      inventory: 'inventory',
      invoices: 'invoices',
      customers: 'customers',
      refunds: 'refunds',
      expenses: 'expenses',
      reports: 'reports',
      users: 'users',
      backup: 'backup',
      settings: 'settings',
      'employee-performance': 'employee_performance',
    };
    if (hasPermission(pagePermissions[page])) return page;
    if (page === 'products' && hasPermission('products.add')) return page;
    // Find first page the user has access to
    const fallback: PageKey = hasPermission('pos') ? 'pos' : 'dashboard';
    if (!hasPermission(pagePermissions[page])) return fallback;
    return fallback;
  };

  const activePage = ensurePage(currentPage);

  const renderPage = () => {
    switch (activePage) {
      case 'dashboard': return <DashboardPage />;
      case 'pos': return <PosPage />;
      case 'products': return <ProductsPage />;
      case 'inventory': return <InventoryPage />;
      case 'invoices': return <InvoicesPage />;
      case 'customers': return <CustomersPage />;
      case 'refunds': return <RefundsPage />;
      case 'expenses': return <ExpensesPage />;
      case 'reports': return <ReportsPage />;
      case 'employee-performance': return <EmployeePerformancePage />;
      case 'users': return <UsersPage />;
      case 'backup': return <BackupPage />;
      case 'settings': return <SettingsPage />;
      default: return <DashboardPage />;
    }
  };

  return (
    <Layout current={activePage} onNavigate={setCurrentPage}>
      {renderPage()}
    </Layout>
  );
}

function App() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <SettingsProvider>
          <AppContent />
          <ToastContainer />
        </SettingsProvider>
      </AuthProvider>
    </LanguageProvider>
  );
}

export default App;
