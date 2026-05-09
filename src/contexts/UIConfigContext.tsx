import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { api } from '../utils/api';

export interface UIConfig {
  appName: string;
  logoUrl: string | null;
  showReportIssue: boolean;
  showJoinCommunity: boolean;
  showGitHubStar: boolean;
  showVersion: boolean;
  // Settings menu visibility
  showSettingsAgents: boolean;
  showSettingsAppearance: boolean;
  showSettingsGit: boolean;
  showSettingsApi: boolean;
  showSettingsTasks: boolean;
  showSettingsPlugins: boolean;
  showSettingsNotifications: boolean;
  showSettingsAbout: boolean;
  // Admin-controlled allowed providers (users can only see/select from these)
  allowedProviders: string[];
}

const defaultConfig: UIConfig = {
  appName: 'CloudCLI',
  logoUrl: null,
  showReportIssue: true,
  showJoinCommunity: true,
  showGitHubStar: true,
  showVersion: true,
  showSettingsAgents: true,
  showSettingsAppearance: true,
  showSettingsGit: true,
  showSettingsApi: true,
  showSettingsTasks: true,
  showSettingsPlugins: true,
  showSettingsNotifications: true,
  showSettingsAbout: true,
  allowedProviders: ['claude', 'cursor', 'codex', 'gemini'],
};

type UIConfigContextType = {
  config: UIConfig;
  refreshConfig: () => Promise<void>;
};

const UIConfigContext = createContext<UIConfigContextType | null>(null);

export const useUIConfig = () => {
  const context = useContext(UIConfigContext);
  if (!context) {
    throw new Error('useUIConfig must be used within a UIConfigProvider');
  }
  return context;
};

export const UIConfigProvider = ({ children }: { children: ReactNode }) => {
  const [config, setConfig] = useState<UIConfig>(defaultConfig);

  const refreshConfig = useCallback(async () => {
    try {
      const response = await api.get('/settings/ui-config');
      const data = await response.json();
      const config = data?.config || defaultConfig;
      setConfig(config);
      // Update document title
      if (config.appName) {
        document.title = config.appName;
      }
    } catch (error) {
      console.error('Failed to load UI config:', error);
    }
  }, []);

  useEffect(() => {
    refreshConfig();
  }, [refreshConfig]);

  useEffect(() => {
    // Listen for config changes from admin panel
    const handleConfigChange = (event: CustomEvent<UIConfig>) => {
      setConfig(event.detail);
      if (event.detail.appName) {
        document.title = event.detail.appName;
      }
    };

    window.addEventListener('ui-config-changed', handleConfigChange as EventListener);
    return () => {
      window.removeEventListener('ui-config-changed', handleConfigChange as EventListener);
    };
  }, []);

  return (
    <UIConfigContext.Provider value={{ config, refreshConfig }}>
      {children}
    </UIConfigContext.Provider>
  );
};

export default UIConfigContext;
