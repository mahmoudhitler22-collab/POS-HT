import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type Language = 'ar' | 'en';

const STORAGE_KEY = 'elakrammen_language';

const ar: Record<string, string> = {
  'Dashboard': 'لوحة التحكم',
  'POS / Sales': 'نقطة البيع',
  'Products': 'المنتجات',
  'Inventory': 'المخزون',
  'Invoices': 'الفواتير',
  'Customers': 'العملاء',
  'Refunds': 'الاسترجاعات',
  'Expenses': 'المصروفات',
  'Reports': 'التقارير',
  'Employee Performance': 'أداء الموظفين',
  'Users': 'المستخدمون',
  'Backup & Restore': 'النسخ الاحتياطي والاستعادة',
  'Settings': 'الإعدادات',
  'POS System': 'نظام نقاط البيع',
  'Sign Out': 'تسجيل الخروج',
  'Sign In': 'تسجيل الدخول',
  'Username': 'اسم المستخدم',
  'Password': 'كلمة المرور',
  'Enter username': 'أدخل اسم المستخدم',
  'Enter password': 'أدخل كلمة المرور',
  'Please wait...': 'يرجى الانتظار...',
  'Login failed': 'تعذر تسجيل الدخول',
  '100% Offline · Data stored locally on this device': 'يعمل دون إنترنت · تُحفظ البيانات محليًا على هذا الجهاز',
  'Loading ELAKRAMMEN POS...': 'جارٍ تحميل نظام الكرامين...',
  'Arabic': 'العربية',
  'English': 'English',
  'Switch language': 'تغيير اللغة',
  'Point of Sale': 'نقطة البيع',
  'Search product name, scan barcode, or enter SKU...': 'ابحث باسم المنتج أو امسح الباركود أو أدخل كود المنتج...',
  'Search or scan to start a sale': 'ابحث أو امسح الباركود لبدء عملية بيع',
  'Use the search bar above to find products': 'استخدم مربع البحث أعلاه للعثور على المنتجات',
  'No products found': 'لم يتم العثور على منتجات',
  'Cart': 'سلة المشتريات',
  'Your cart is empty': 'سلة المشتريات فارغة',
  'Add products to start a sale': 'أضف منتجات لبدء البيع',
  'No Discount': 'بدون خصم',
  'Discount %': 'خصم %',
  'Discount EGP': 'خصم بالجنيه',
  'Subtotal': 'الإجمالي قبل الخصم',
  'Discount': 'الخصم',
  'Total': 'الإجمالي',
  'Complete Payment': 'إتمام الدفع',
  'Cancel': 'إلغاء',
  'Complete Sale': 'إتمام البيع',
  'Total Amount Due': 'إجمالي المبلغ المستحق',
  'Payment Method': 'طريقة الدفع',
  'Cash': 'نقدي',
  'Card / Visa': 'بطاقة / فيزا',
  'Other': 'أخرى',
  'Business overview and performance metrics': 'نظرة عامة على أداء النشاط',
  'Today': 'اليوم',
  'Yesterday': 'أمس',
  'This Week': 'هذا الأسبوع',
  'This Month': 'هذا الشهر',
  'Last Month': 'الشهر الماضي',
  'This Year': 'هذا العام',
  'All Time': 'كل المدة',
  'Total Sales': 'صافي المبيعات',
  'Gross Profit': 'إجمالي الربح',
  'Total Expenses': 'إجمالي المصروفات',
  'Net Profit': 'صافي الربح',
  'Discounts Given': 'الخصومات الممنوحة',
  'Inventory Value': 'قيمة المخزون',
  'Best Selling Products': 'المنتجات الأكثر مبيعًا',
  'Sales by Payment Method': 'المبيعات حسب طريقة الدفع',
  'Low Stock Alerts': 'تنبيهات انخفاض المخزون',
  'Slow Moving Products': 'المنتجات بطيئة الحركة',
  'Refunds / Returns': 'الاسترجاعات',
  'Find a sale and process full or partial refunds': 'ابحث عن فاتورة ونفّذ استرجاعًا كليًا أو جزئيًا',
  'View Refund History': 'سجل الاسترجاعات',
  'Search by invoice number or customer name...': 'ابحث برقم الفاتورة أو اسم العميل...',
  'Invoice': 'الفاتورة',
  'Date': 'التاريخ',
  'Customer': 'العميل',
  'Cashier': 'الكاشير',
  'Action': 'إجراء',
  'View & Refund': 'عرض واسترجاع',
  'Back to Sales List': 'العودة لقائمة المبيعات',
  'Original Total': 'الإجمالي الأصلي',
  'Select items to refund:': 'اختر الأصناف المطلوب استرجاعها:',
  'Qty:': 'الكمية:',
  'Refund Reason': 'سبب الاسترجاع',
  'Reason for refund...': 'اكتب سبب الاسترجاع...',
  'Total Refund Amount': 'إجمالي مبلغ الاسترجاع',
  'Process Refund': 'تنفيذ الاسترجاع',
  'Confirm Refund': 'تأكيد الاسترجاع',
  'Yes, Process Refund': 'نعم، نفّذ الاسترجاع',
  'Refund History': 'سجل الاسترجاعات',
  'All processed refunds': 'كل الاسترجاعات المنفذة',
} as const;

// Text used by the operational screens. Keeping this in one catalogue means
// new screens and transient UI (dialogs, tooltips and toast messages) follow
// the selected language as well, instead of being translated page by page.
const operationalAr: Record<string, string> = {
  'Manage your product catalog, categories, brands, and suppliers': 'إدارة المنتجات والتصنيفات والعلامات التجارية والموردين',
  'Add Product': 'إضافة منتج', 'Edit Product': 'تعديل المنتج', 'Archive Product': 'أرشفة المنتج',
  'Save Product': 'حفظ المنتج', 'Saving...': 'جارٍ الحفظ...', 'Product Name *': 'اسم المنتج *',
  'SKU / Product Code': 'كود المنتج / SKU', 'Generate': 'توليد', 'Type': 'النوع', 'Category': 'التصنيف',
  'Brand': 'العلامة التجارية', 'Supplier': 'المورد', 'Size': 'المقاس', 'Color': 'اللون',
  'Barcode': 'الباركود',
  'Purchase Cost (EGP)': 'سعر الشراء (جنيه)', 'Selling Price (EGP) *': 'سعر البيع (جنيه) *',
  'Initial Stock Quantity': 'كمية المخزون الابتدائية', 'Minimum Stock Level': 'الحد الأدنى للمخزون',
  'Notes': 'ملاحظات', 'Search by name, SKU, or barcode...': 'ابحث بالاسم أو كود المنتج أو الباركود...',
  'All Categories': 'كل التصنيفات', 'All Brands': 'كل العلامات التجارية', 'No products found': 'لا توجد منتجات',
  'Edit': 'تعديل', 'Archive': 'أرشفة', 'Restore': 'استعادة', 'Print barcode labels': 'طباعة ملصقات الباركود',
  'New category name': 'اسم التصنيف الجديد', 'New brand name': 'اسم العلامة التجارية الجديد',
  'No categories yet': 'لا توجد تصنيفات بعد', 'No brands yet': 'لا توجد علامات تجارية بعد',
  'Supplier name': 'اسم المورد', 'Phone': 'الهاتف', 'Name': 'الاسم', 'No suppliers yet': 'لا يوجد موردون بعد',
  'Add Supplier': 'إضافة مورد', 'Print Barcode Labels': 'طباعة ملصقات الباركود',
  'Maximum 1000 labels per print': 'الحد الأقصى 1000 ملصق في المرة الواحدة',
  'Search products...': 'ابحث عن المنتجات...', 'All Products': 'كل المنتجات', 'Low Stock': 'مخزون منخفض',
  'Out of Stock': 'نفد المخزون', 'Stock Overview': 'نظرة عامة على المخزون',
  'Stock Movements': 'حركات المخزون', 'Stocktake': 'جرد المخزون', 'Adjust Stock': 'تعديل المخزون',
  'Quantity': 'الكمية', 'Current Stock': 'المخزون الحالي', 'Minimum': 'الحد الأدنى', 'Status': 'الحالة',
  'In Stock': 'متوفر', 'Reason': 'السبب', 'Adjust': 'تعديل', 'System Quantity': 'كمية النظام',
  'Counted Quantity': 'الكمية الفعلية', 'Difference': 'الفرق', 'Complete Stocktake': 'إتمام الجرد',
  'Search by name or phone...': 'ابحث بالاسم أو الهاتف...', 'Manage customer information and loyalty points': 'إدارة بيانات العملاء ونقاط الولاء',
  'Add Customer': 'إضافة عميل', 'Edit Customer': 'تعديل العميل', 'No customers yet': 'لا يوجد عملاء بعد',
  'Purchases': 'المشتريات', 'Total Spent': 'إجمالي الإنفاق', 'Last Purchase': 'آخر عملية شراء', 'Points': 'النقاط',
  'Actions': 'الإجراءات', 'View and reprint past sales invoices': 'عرض وإعادة طباعة فواتير المبيعات السابقة',
  'Search by invoice number or customer...': 'ابحث برقم الفاتورة أو العميل...', 'Clear': 'مسح',
  'Invoice #': 'رقم الفاتورة', 'Payment': 'الدفع', 'No invoices found': 'لا توجد فواتير',
  'View Invoice': 'عرض الفاتورة', 'Reprint invoice': 'إعادة طباعة الفاتورة',
  'Current Sale': 'البيع الحالي', 'Walk-in Customer': 'عميل نقدي', 'each': 'للقطعة',
  'Charge': 'تحصيل', 'Stock:': 'المخزون:', 'Out': 'نفد', 'Low': 'منخفض',
  'Search by invoice number or customer name...': 'ابحث برقم الفاتورة أو اسم العميل...',
  'Calculated using actual price paid after discounts': 'يُحسب وفق السعر المدفوع فعليًا بعد الخصومات',
  'Settings saved': 'تم حفظ الإعدادات', 'New payment method': 'طريقة دفع جديدة',
  'General Settings': 'الإعدادات العامة', 'Store Information': 'بيانات المتجر', 'Payment Methods': 'طرق الدفع',
  'Backup created successfully': 'تم إنشاء النسخة الاحتياطية بنجاح', 'Backup failed': 'فشل إنشاء النسخة الاحتياطية',
  'Backup is only available in the desktop application': 'النسخ الاحتياطي متاح في تطبيق سطح المكتب فقط',
  'This feature is only available in the desktop application': 'هذه الميزة متاحة في تطبيق سطح المكتب فقط',
  'Backup saved to': 'تم حفظ النسخة الاحتياطية في', 'Database restored successfully. Please restart the application.': 'تمت استعادة قاعدة البيانات بنجاح. أعد تشغيل التطبيق.',
  'Restore failed': 'فشلت استعادة النسخة الاحتياطية', 'Backup deleted': 'تم حذف النسخة الاحتياطية',
  'Failed to delete backup': 'تعذر حذف النسخة الاحتياطية', 'Create Backup': 'إنشاء نسخة احتياطية',
  'Save Backup To...': 'حفظ النسخة الاحتياطية في...', 'Database Location': 'موقع قاعدة البيانات',
  'Backup Directory': 'مجلد النسخ الاحتياطية', 'Available Backups': 'النسخ الاحتياطية المتاحة',
  'No backups yet': 'لا توجد نسخ احتياطية بعد', 'Restore Database': 'استعادة قاعدة البيانات',
  'Delete Backup': 'حذف النسخة الاحتياطية', 'Delete': 'حذف', 'Save': 'حفظ', 'Add': 'إضافة',
  'User Management': 'إدارة المستخدمين', 'Add User': 'إضافة مستخدم', 'Edit User': 'تعديل المستخدم',
  'User disabled': 'تم تعطيل المستخدم', 'User re-enabled': 'تمت إعادة تفعيل المستخدم',
  'User updated': 'تم تحديث المستخدم', 'User created': 'تم إنشاء المستخدم',
  'You cannot delete your own account': 'لا يمكنك حذف حسابك بنفسك',
  'Employee Performance': 'أداء الموظفين', 'Performance by employee': 'الأداء حسب الموظف',
  'No sales in this period': 'لا توجد مبيعات خلال هذه الفترة', 'sold': 'تم بيعه',
  'Net revenue:': 'صافي الإيراد:', 'COGS:': 'تكلفة البضاعة المباعة:', 'Refunds:': 'الاسترجاعات:',
  'transactions': 'عمليات', 'All products are well stocked': 'كل المنتجات متوفرة بمستوى جيد',
  'more': 'أخرى', 'No slow-moving products in this period': 'لا توجد منتجات بطيئة الحركة خلال هذه الفترة',
  'Product updated': 'تم تحديث المنتج', 'Product created': 'تم إنشاء المنتج',
  'Category added': 'تمت إضافة التصنيف', 'Category updated': 'تم تحديث التصنيف', 'Category deleted': 'تم حذف التصنيف',
  'Brand added': 'تمت إضافة العلامة التجارية', 'Brand updated': 'تم تحديث العلامة التجارية', 'Brand deleted': 'تم حذف العلامة التجارية',
  'Supplier added': 'تمت إضافة المورد', 'Supplier updated': 'تم تحديث المورد', 'Supplier deleted': 'تم حذف المورد',
  'Printing failed': 'فشلت الطباعة', 'Receipt sent to printer': 'تم إرسال الإيصال إلى الطابعة',
  'Cash': 'نقدي', 'Card / Visa': 'بطاقة / فيزا', 'Instapay': 'إنستاباي', 'Other': 'أخرى',
  'owner': 'المالك', 'manager': 'المدير', 'cashier': 'الكاشير', 'inventory': 'مسؤول المخزون',
  'Variants (Color × Size)': 'المتغيرات (اللون × المقاس)',
  'Add colors and sizes to generate variant combinations automatically': 'أضف الألوان والمقاسات لتوليد المتغيرات تلقائيًا',
  'Colors': 'الألوان', 'Sizes': 'المقاسات', 'Add Color': 'إضافة لون', 'Add Size': 'إضافة مقاس',
  'Color name': 'اسم اللون', 'Size name': 'اسم المقاس',
  'Variant Matrix': 'جدول المتغيرات', 'Qty': 'الكمية', 'Active': 'مفعّل', 'Inactive': 'غير مفعّل',
  'No colors or sizes added yet': 'لم تتم إضافة ألوان أو مقاسات بعد',
  'Add at least one color and one size to see the matrix': 'أضف لونًا واحدًا على الأقل ومقاسًا واحدًا لعرض الجدول',
  'This combination is not available': 'هذا التركيب غير متاح',
  'Enable': 'تفعيل', 'Disable': 'تعطيل',
  'Duplicate color name': 'اسم اللون مكرر', 'Duplicate size name': 'اسم المقاس مكرر',
  'Total active variants': 'إجمالي المتغيرات المفعّلة',
  'Receipt': 'الإيصال', 'Receipt Preview': 'معاينة الإيصال', 'Close': 'إغلاق', 'Printing...': 'جارٍ الطباعة...',
  'Print Receipt': 'طباعة الإيصال', 'Printer': 'الطابعة', 'Default': 'الافتراضي', 'Item': 'الصنف',
  'Price': 'السعر', 'This is a computer-generated receipt': 'هذا إيصال صادر من النظام',
};

function translateArabicText(value: string): string {
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  const key = value.trim();
  if (!key) return value;

  const direct = ar[key] ?? operationalAr[key];
  if (direct) return `${leading}${direct}${trailing}`;

  const patterns: Array<[RegExp, (...parts: string[]) => string]> = [
    [/^Added: (.+)$/, (name) => `تمت إضافة: ${name}`],
    [/^Sale completed: (.+)$/, (number) => `تم إتمام البيع: ${number}`],
    [/^Refund processed: (.+)$/, (amount) => `تم تنفيذ الاسترجاع: ${amount}`],
    [/^Only (.+) in stock$/, (quantity) => `المتاح في المخزون: ${quantity}`],
    [/^(.+) is out of stock$/, (name) => `${name} غير متوفر في المخزون`],
    [/^(\d+) invoices found$/, (count) => `تم العثور على ${count} فاتورة`],
    [/^No products found for "(.+)"$/, (search) => `لم يتم العثور على منتجات لـ "${search}"`],
    [/^Maximum discount is (.+)$/, (amount) => `الحد الأقصى للخصم هو ${amount}`],
    [/^Discount on (.+) exceeds maximum of (.+)$/, (name, amount) => `خصم ${name} يتجاوز الحد الأقصى ${amount}`],
  ];
  for (const [pattern, formatter] of patterns) {
    const match = key.match(pattern);
    if (match) return `${leading}${formatter(...match.slice(1))}${trailing}`;
  }
  return value;
}

interface LanguageContextValue {
  language: Language;
  isArabic: boolean;
  setLanguage: (language: Language) => void;
  t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function initialLanguage(): Language {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'ar' || saved === 'en') return saved;
  // Arabic is the first-run default, while the switcher keeps English one tap away.
  return 'ar';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const isArabic = language === 'ar';
  const originalText = useRef(new WeakMap<Text, string>());
  const originalAttributes = useRef(new WeakMap<Element, Map<string, string>>());

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
    document.documentElement.dir = isArabic ? 'rtl' : 'ltr';
  }, [language, isArabic]);

  useEffect(() => {
    const attributeNames = ['placeholder', 'title', 'aria-label'];
    const localizeNode = (node: Node) => {
      const localizeText = (text: Text) => {
        const source = originalText.current.get(text) ?? text.data;
        if (!originalText.current.has(text)) originalText.current.set(text, source);
        const next = isArabic ? translateArabicText(source) : source;
        if (text.data !== next) text.data = next;
      };
      const localizeElement = (element: Element) => {
        const sources = originalAttributes.current.get(element) ?? new Map<string, string>();
        originalAttributes.current.set(element, sources);
        for (const name of attributeNames) {
          const current = element.getAttribute(name);
          if (current === null) continue;
          const source = sources.get(name) ?? current;
          sources.set(name, source);
          const next = isArabic ? translateArabicText(source) : source;
          if (current !== next) element.setAttribute(name, next);
        }
      };

      if (node.nodeType === Node.TEXT_NODE) {
        localizeText(node as Text);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const element = node as Element;
      if (['SCRIPT', 'STYLE'].includes(element.tagName)) return;
      localizeElement(element);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let current: Node | null = walker.currentNode;
      while (current) {
        if (current.nodeType === Node.TEXT_NODE) localizeText(current as Text);
        else if (current.nodeType === Node.ELEMENT_NODE) localizeElement(current as Element);
        current = walker.nextNode();
      }
    };

    localizeNode(document.body);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') localizeNode(record.target);
        for (const node of record.addedNodes) localizeNode(node);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [isArabic]);

  const value = useMemo<LanguageContextValue>(() => ({
    language,
    isArabic,
    setLanguage,
    t: (key) => isArabic ? translateArabicText(key) : key,
  }), [language, isArabic]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within LanguageProvider');
  return context;
}
