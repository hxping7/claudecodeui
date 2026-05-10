import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, Info } from 'lucide-react';
import { authenticatedFetch } from '../../../../utils/api';
import SettingsCard from '../SettingsCard';
import { Button } from '../../../../shared/view/ui';

type AuthMode = 'database' | 'linux';

export default function AuthSettingsTab() {
  const { t } = useTranslation('settings');
  const [authMode, setAuthMode] = useState<AuthMode>('database');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Fetch current auth mode
  useEffect(() => {
    const fetchAuthMode = async () => {
      try {
        const response = await authenticatedFetch('/api/settings/auth-mode', {
          method: 'GET',
        });
        if (response.ok) {
          const data = await response.json();
          setAuthMode(data.authMode || 'database');
        }
      } catch (err) {
        console.error('Failed to fetch auth mode:', err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchAuthMode();
  }, []);

  const handleAuthModeChange = async (newMode: AuthMode) => {
    if (newMode === authMode) return;

    setIsSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const response = await authenticatedFetch('/api/settings/auth-mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authMode: newMode }),
      });

      if (response.ok) {
        setAuthMode(newMode);
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to save auth mode');
      }
    } catch (err) {
      setError('Failed to save auth mode');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-lg font-semibold text-foreground">{t('auth.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('auth.description')}</p>
      </div>

      <SettingsCard>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <h3 className="font-medium text-foreground">{t('auth.mode')}</h3>
          </div>

          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-4 transition-colors hover:bg-accent/50">
              <input
                type="radio"
                name="authMode"
                value="database"
                checked={authMode === 'database'}
                onChange={() => handleAuthModeChange('database')}
                disabled={isSaving}
                className="h-4 w-4 accent-primary"
              />
              <div className="flex-1">
                <div className="font-medium text-foreground">{t('auth.databaseMode')}</div>
                <div className="text-sm text-muted-foreground">{t('auth.databaseModeDesc')}</div>
              </div>
            </label>

            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-4 transition-colors hover:bg-accent/50">
              <input
                type="radio"
                name="authMode"
                value="linux"
                checked={authMode === 'linux'}
                onChange={() => handleAuthModeChange('linux')}
                disabled={isSaving}
                className="h-4 w-4 accent-primary"
              />
              <div className="flex-1">
                <div className="font-medium text-foreground">{t('auth.linuxMode')}</div>
                <div className="text-sm text-muted-foreground">{t('auth.linuxModeDesc')}</div>
              </div>
            </label>
          </div>

          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {success && (
            <div className="rounded-lg bg-green-500/10 p-3 text-sm text-green-600">
              {t('auth.saveSuccess')}
            </div>
          )}

          {isSaving && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              {t('auth.saving')}
            </div>
          )}
        </div>
      </SettingsCard>

      <SettingsCard>
        <div className="flex gap-3">
          <Info className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
          <div className="space-y-2 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{t('auth.infoTitle')}</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>{t('auth.infoDatabase')}</li>
              <li>{t('auth.infoLinux')}</li>
            </ul>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}