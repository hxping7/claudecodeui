import { createContext, useContext, useState, useEffect, useCallback, ReactNode, useRef } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

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
  logoUrl: '/logo1_64.png',
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
  isLoading: boolean;
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
  const [isLoading, setIsLoading] = useState(true);
  const { token } = useAuth();
  const previousTokenRef = useRef<string | null | undefined>(undefined);

  const refreshConfig = useCallback(async () => {
    try {
      setIsLoading(true);
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
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // In OSS mode: load config immediately on mount
    // In Platform mode: load config when user logs in (token changes from null to a value)
    if (!IS_PLATFORM) {
      // OSS mode: always load on mount and when token changes
      const tokenChanged = previousTokenRef.current !== token;
      if (tokenChanged) {
        previousTokenRef.current = token;
        refreshConfig();
      }
    } else {
      // Platform mode: only load when logged in
      if (token !== null && previousTokenRef.current !== token) {
        previousTokenRef.current = token;
        refreshConfig();
      }
    }
  }, [refreshConfig, token]);

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
    <UIConfigContext.Provider value={{ config, isLoading, refreshConfig }}>
      {children}
    </UIConfigContext.Provider>
  );
};

export default UIConfigContext;
