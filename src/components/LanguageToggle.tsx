import { Languages } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

export function LanguageToggle({ className = '' }: { className?: string }) {
  const { language, setLanguage, t } = useLanguage();
  const nextLanguage = language === 'ar' ? 'en' : 'ar';

  return (
    <button
      type="button"
      onClick={() => setLanguage(nextLanguage)}
      aria-label={t('Switch language')}
      title={t('Switch language')}
      className={`inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 ${className}`}
    >
      <Languages size={17} />
      {language === 'ar' ? t('English') : t('Arabic')}
    </button>
  );
}
