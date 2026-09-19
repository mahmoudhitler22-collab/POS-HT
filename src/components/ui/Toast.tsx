import { useEffect, useState, useCallback } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

type ToastType = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

let toastIdCounter = 0;
let pushToastFn: ((type: ToastType, message: string) => void) | null = null;

export function toast(type: ToastType, message: string) {
  if (pushToastFn) pushToastFn(type, message);
}

const icons = {
  success: <CheckCircle size={20} className="text-emerald-600" />,
  error: <AlertCircle size={20} className="text-red-600" />,
  info: <Info size={20} className="text-blue-600" />,
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const { isArabic } = useLanguage();

  const pushToast = useCallback((type: ToastType, message: string) => {
    const id = ++toastIdCounter;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  useEffect(() => {
    pushToastFn = pushToast;
    return () => { pushToastFn = null; };
  }, [pushToast]);

  return (
    <div className={`fixed bottom-6 ${isArabic ? 'left-6' : 'right-6'} z-[100] flex flex-col gap-2 pointer-events-none`}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex items-center gap-3 bg-white rounded-xl shadow-lg border border-slate-200 px-4 py-3 min-w-[280px] max-w-[400px] pointer-events-auto animate-slide-in"
        >
          {icons[t.type]}
          <p className="flex-1 text-sm text-slate-700">{t.message}</p>
          <button
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            className="text-slate-400 hover:text-slate-600"
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
