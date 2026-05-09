import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, FileCode, X, Check, AlertCircle } from 'lucide-react';
import { Button } from '../../../../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../../../../utils/api';
import SessionProviderLogo from '../../../../../../llm-logo-provider/SessionProviderLogo';
import type { AgentProvider } from '../../../../../types/types';

type UserAgentConfigContentProps = {
  agent: AgentProvider;
};

const PROVIDER_SETTINGS_NAMES: Record<string, string> = {
  claude: '~/.claude/settings.json',
  cursor: '~/.cursor/settings.json',
  codex: '~/.codex/settings.json',
  gemini: '~/.gemini/settings.json',
};

export default function UserAgentConfigContent({ agent }: UserAgentConfigContentProps) {
  const { t } = useTranslation('settings');

  // Settings.json editor state
  const [showSettingsEditor, setShowSettingsEditor] = useState(false);
  const [settingsContent, setSettingsContent] = useState('{}');
  const [settingsPath, setSettingsPath] = useState('');
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSuccess, setSettingsSuccess] = useState(false);

  // Load settings.json content
  const handleOpenSettingsEditor = async () => {
    setIsLoadingSettings(true);
    setSettingsError(null);
    setSettingsSuccess(false);
    setShowSettingsEditor(true);

    try {
      const response = await authenticatedFetch(`/api/settings/provider-settings/${agent}`);

      if (!response.ok) {
        throw new Error('Failed to load settings file');
      }

      const data = await response.json();
      setSettingsContent(data.content || '{}');
      setSettingsPath(data.path || '');
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setIsLoadingSettings(false);
    }
  };

  // Save settings.json content
  const handleSaveSettings = async () => {
    setIsSavingSettings(true);
    setSettingsError(null);

    try {
      // Validate JSON first
      JSON.parse(settingsContent);

      const response = await authenticatedFetch(`/api/settings/provider-settings/${agent}`, {
        method: 'PUT',
        body: JSON.stringify({ content: settingsContent }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save settings');
      }

      setSettingsSuccess(true);
      setTimeout(() => {
        setSettingsSuccess(false);
        setShowSettingsEditor(false);
      }, 1500);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setIsSavingSettings(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="mb-4 flex items-center gap-3">
        <SessionProviderLogo provider={agent} className="h-6 w-6" />
        <div>
          <h3 className="text-lg font-medium text-foreground">
            {t('agents.modelSettings.title', { defaultValue: '模型设置' })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t('agents.modelSettings.description', { defaultValue: '编辑智能体配置文件' })}
          </p>
        </div>
      </div>

      {/* Edit Settings Button */}
      <div className="flex flex-col gap-4">
        <Button
          variant="outline"
          onClick={handleOpenSettingsEditor}
          className="w-full sm:w-auto"
        >
          <FileCode className="mr-2 h-4 w-4" />
          {t('agents.modelSettings.editSettingsJson', { defaultValue: '编辑 settings.json' })}
        </Button>

        <p className="text-sm text-muted-foreground">
          {t('agents.modelSettings.path', { defaultValue: '文件路径' })}: <code className="rounded bg-muted px-1 text-xs">{PROVIDER_SETTINGS_NAMES[agent]}</code>
        </p>
      </div>

      {/* Settings.json Editor Modal */}
      {showSettingsEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-background shadow-lg">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h3 className="text-lg font-medium text-foreground">
                  {t('agents.modelSettings.editSettingsJson', { defaultValue: '编辑 settings.json' })}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {settingsPath || PROVIDER_SETTINGS_NAMES[agent]}
                </p>
              </div>
              <button
                onClick={() => setShowSettingsEditor(false)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-4">
              {isLoadingSettings ? (
                <div className="flex items-center justify-center py-8">
                  <div className="text-muted-foreground">{t('common.loading', { defaultValue: 'Loading...' })}</div>
                </div>
              ) : (
                <>
                  {settingsError && (
                    <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-900/20 dark:text-red-200">
                      <AlertCircle className="h-4 w-4" />
                      {settingsError}
                    </div>
                  )}

                  {settingsSuccess && (
                    <div className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-800/60 dark:bg-green-900/20 dark:text-green-200">
                      <Check className="h-4 w-4" />
                      {t('agents.modelSettings.saveSuccess', { defaultValue: '保存成功' })}
                    </div>
                  )}

                  <textarea
                    value={settingsContent}
                    onChange={(e) => {
                      setSettingsContent(e.target.value);
                      setSettingsError(null);
                      setSettingsSuccess(false);
                    }}
                    className="h-96 w-full rounded-md border border-input bg-background p-3 font-mono text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="{\n  \n}"
                    spellCheck={false}
                  />

                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('agents.modelSettings.settingsJsonHint', { defaultValue: '直接编辑 JSON 配置文件，保存后立即生效' })}
                  </p>
                </>
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <Button
                variant="outline"
                onClick={() => setShowSettingsEditor(false)}
              >
                {t('common.cancel', { defaultValue: '取消' })}
              </Button>
              <Button
                onClick={handleSaveSettings}
                disabled={isSavingSettings || isLoadingSettings}
              >
                <Save className="mr-2 h-4 w-4" />
                {isSavingSettings
                  ? t('common.saving', { defaultValue: '保存中...' })
                  : t('common.save', { defaultValue: '保存' })}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
