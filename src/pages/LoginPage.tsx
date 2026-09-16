import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Store, Lock, AlertCircle } from 'lucide-react';

export function LoginPage() {
  const { login } = useAuth();
  const { t } = useLanguage();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const result = await login(username, password);
    if (!result.success) {
      setError(result.error || t('Login failed'));
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
      <div className="w-full max-w-md">
        <div className="mb-4 flex justify-end">
          <LanguageToggle className="border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700" />
        </div>
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-teal-500/10 border border-teal-400/20 mb-4">
            <Store className="text-teal-400" size={32} />
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">ELAKRAMMEN</h1>
          <p className="text-slate-400 mt-1 text-sm tracking-widest uppercase">{t('POS System')}</p>
        </div>

        <div className="card p-8">
          <h2 className="text-xl font-semibold text-slate-900 mb-6">{t('Sign In')}</h2>

          {error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-700">
              <AlertCircle size={18} />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label={t('Username')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('Enter username')}
              autoFocus
              required
            />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">{t('Password')}</label>
              <div className="relative">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('Enter password')}
                  required
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-transparent transition-all"
                />
                <Lock className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              </div>
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={loading}>
              {loading ? t('Please wait...') : t('Sign In')}
            </Button>
          </form>
        </div>

        <p className="text-center text-slate-500 text-xs mt-6">
          {t('100% Offline · Data stored locally on this device')}
        </p>
      </div>
    </div>
  );
}
