import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../shared/view/ui';
import { Settings, Upload, X, Image as ImageIcon } from 'lucide-react';
import { api } from '../../../utils/api';

interface UIConfig {
  appName: string;
  logoUrl: string | null;
  showReportIssue: boolean;
  showJoinCommunity: boolean;
  showGitHubStar: boolean;
  showVersion: boolean;
}

const defaultConfig: UIConfig = {
  appName: 'CloudCLI',
  logoUrl: null,
  showReportIssue: true,
  showJoinCommunity: true,
  showGitHubStar: true,
  showVersion: true,
};

export default function UISettingsPanel() {
  const { t } = useTranslation('admin');
  const [config, setConfig] = useState<UIConfig>(defaultConfig);
  const [originalConfig, setOriginalConfig] = useState<UIConfig>(defaultConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const response = await api.get('/settings/ui-config');
      const data = await response.json();
      const config = data?.config || defaultConfig;
      setConfig(config);
      setOriginalConfig(config);
    } catch (error) {
      setMessage({ type: 'error', text: t('uiSettings.loadError') });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await api.put('/settings/ui-config', config);
      setOriginalConfig(config);
      setMessage({ type: 'success', text: t('uiSettings.saved') });
      // Trigger a custom event to notify other components
      window.dispatchEvent(new CustomEvent('ui-config-changed', { detail: config }));
    } catch (error) {
      setMessage({ type: 'error', text: t('uiSettings.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Check file size (max 2MB)
    if (file.size > 2 * 1024 * 1024) {
      setMessage({ type: 'error', text: 'Logo file size must be less than 2MB' });
      return;
    }

    const formData = new FormData();
    formData.append('logo', file);

    try {
      const response = await api.post('/settings/upload-logo', formData);
      const data = await response.json();
      setConfig(prev => ({ ...prev, logoUrl: data.logoUrl }));
      setMessage(null);
    } catch (error) {
      setMessage({ type: 'error', text: t('uiSettings.saveError') });
    }
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemoveLogo = () => {
    setConfig(prev => ({ ...prev, logoUrl: null }));
  };

  const handleToggle = (key: keyof UIConfig) => {
    if (typeof config[key] === 'boolean') {
      setConfig(prev => ({ ...prev, [key]: !prev[key] }));
    }
  };

  const hasChanges = JSON.stringify(config) !== JSON.stringify(originalConfig);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">{t('uiSettings.title')}</h2>
        <Button onClick={handleSave} disabled={!hasChanges || saving}>
          {saving ? t('uiSettings.saving') : t('uiSettings.save')}
        </Button>
      </div>

      {message && (
        <div
          className={`p-3 rounded-md ${
            message.type === 'success'
              ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Branding Section */}
      <div className="bg-card rounded-lg border p-6 space-y-6">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Settings className="h-5 w-5" />
          {t('uiSettings.branding')}
        </h3>

        <div className="space-y-4">
          {/* App Name */}
          <div>
            <label className="block text-sm font-medium mb-2">
              {t('uiSettings.appName')}
            </label>
            <input
              type="text"
              value={config.appName}
              onChange={(e) => setConfig(prev => ({ ...prev, appName: e.target.value }))}
              placeholder={t('uiSettings.appNamePlaceholder')}
              className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          {/* Logo */}
          <div>
            <label className="block text-sm font-medium mb-2">
              {t('uiSettings.logo')}
            </label>
            <div className="flex items-start gap-4">
              {config.logoUrl ? (
                <div className="relative">
                  <img
                    src={config.logoUrl}
                    alt="Logo"
                    className="h-12 w-12 object-contain rounded border"
                  />
                  <button
                    onClick={handleRemoveLogo}
                    className="absolute -top-1 -right-1 p-0.5 bg-red-500 text-white rounded-full hover:bg-red-600"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <div className="h-12 w-12 border-2 border-dashed rounded flex items-center justify-center text-muted-foreground">
                  <ImageIcon className="h-6 w-6" />
                </div>
              )}
              <div className="flex-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleLogoUpload}
                  className="hidden"
                />
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  className="mb-2"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  {t('uiSettings.uploadLogo')}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t('uiSettings.logoHint')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Visibility Section */}
      <div className="bg-card rounded-lg border p-6 space-y-6">
        <h3 className="text-lg font-semibold">{t('uiSettings.visibility')}</h3>

        <div className="space-y-3">
          {[
            { key: 'showReportIssue', label: t('uiSettings.showReportIssue') },
            { key: 'showJoinCommunity', label: t('uiSettings.showJoinCommunity') },
            { key: 'showGitHubStar', label: t('uiSettings.showGitHubStar') },
            { key: 'showVersion', label: t('uiSettings.showVersion') },
          ].map(({ key, label }) => (
            <label
              key={key}
              className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 cursor-pointer"
            >
              <span>{label}</span>
              <button
                onClick={() => handleToggle(key as keyof UIConfig)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  config[key as keyof UIConfig] ? 'bg-primary' : 'bg-muted'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    config[key as keyof UIConfig] ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
