import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useServerPlatform } from '../../../../../hooks/useServerPlatform';
import { useVisibleProviders } from '../../../../../hooks/useVisibleProviders';
import { useUIConfig } from '../../../../../contexts/UIConfigContext';
import type { AgentCategory, AgentProvider } from '../../../types/types';

import type { AgentContext, AgentsSettingsTabProps } from './types';
import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from './sections/AgentCategoryTabsSection';
import AgentSelectorSection from './sections/AgentSelectorSection';

const AGENT_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
};

export default function AgentsSettingsTab({
  providerAuthStatus,
  onProviderLogin,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  geminiPermissionMode,
  onGeminiPermissionModeChange,
  projects,
}: AgentsSettingsTabProps) {
  const { t } = useTranslation('settings');
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>('claude');
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');
  const { isWindowsServer } = useServerPlatform();
  const { config: uiConfig } = useUIConfig();
  const {
    visibleProviders: configuredVisibleProviders,
    isLoading: isLoadingVisibleProviders,
    setVisibleProviders,
  } = useVisibleProviders();

  // Admin-controlled allowed providers
  const adminAllowedProviders = uiConfig.allowedProviders || ['claude', 'cursor', 'codex', 'gemini'];

  // All available agents (excluding cursor on Windows server, and filtered by admin settings)
  const allAgents = useMemo<AgentProvider[]>(() => {
    const agents: AgentProvider[] = ['claude', 'cursor', 'codex', 'gemini'];
    // Filter by admin-allowed providers
    const filtered = agents.filter((id) => adminAllowedProviders.includes(id)) as AgentProvider[];
    // Exclude cursor on Windows
    if (isWindowsServer) {
      return filtered.filter((id) => id !== 'cursor');
    }
    return filtered;
  }, [isWindowsServer, adminAllowedProviders]);

  // Agents visible in the selector (filtered by user configuration)
  const visibleAgents = useMemo<AgentProvider[]>(() => {
    const filtered = allAgents.filter((agent) => configuredVisibleProviders.includes(agent));
    // Ensure at least one agent is visible
    return filtered.length > 0 ? filtered : allAgents.slice(0, 1);
  }, [allAgents, configuredVisibleProviders]);

  useEffect(() => {
    if (isWindowsServer && selectedAgent === 'cursor') {
      setSelectedAgent('claude');
    }
  }, [isWindowsServer, selectedAgent]);

  // Ensure selected agent is still visible after configuration changes
  useEffect(() => {
    if (!visibleAgents.includes(selectedAgent) && visibleAgents.length > 0) {
      setSelectedAgent(visibleAgents[0]);
    }
  }, [visibleAgents, selectedAgent]);

  const handleToggleAgentVisibility = async (agent: AgentProvider, visible: boolean) => {
    let newVisibleProviders: AgentProvider[];
    if (visible) {
      // Add agent to visible list (maintain order)
      newVisibleProviders = [...configuredVisibleProviders, agent].filter(
        (a) => allAgents.includes(a)
      ) as AgentProvider[];
    } else {
      // Remove agent from visible list, but ensure at least one remains
      newVisibleProviders = configuredVisibleProviders.filter((a) => a !== agent);
      if (newVisibleProviders.length === 0) {
        return; // Don't allow removing the last visible agent
      }
    }
    await setVisibleProviders(newVisibleProviders);
  };

  const agentContextById = useMemo<Record<AgentProvider, AgentContext>>(() => ({
    claude: {
      authStatus: providerAuthStatus.claude,
      onLogin: () => onProviderLogin('claude'),
    },
    cursor: {
      authStatus: providerAuthStatus.cursor,
      onLogin: () => onProviderLogin('cursor'),
    },
    codex: {
      authStatus: providerAuthStatus.codex,
      onLogin: () => onProviderLogin('codex'),
    },
    gemini: {
      authStatus: providerAuthStatus.gemini,
      onLogin: () => onProviderLogin('gemini'),
    },
  }), [
    onProviderLogin,
    providerAuthStatus.claude,
    providerAuthStatus.codex,
    providerAuthStatus.cursor,
    providerAuthStatus.gemini,
  ]);

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      {/* Agent Visibility Settings */}
      <div className="flex-shrink-0 border-b border-border px-3 py-2 md:px-4 md:py-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('agents.visibility.title', { defaultValue: 'Show in Provider Selector' })}
        </div>
        <div className="flex flex-wrap gap-2">
          {allAgents.map((agent) => {
            const isVisible = configuredVisibleProviders.includes(agent);
            const isOnlyVisible = visibleAgents.length === 1 && visibleAgents[0] === agent;
            return (
              <label
                key={agent}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                  isVisible
                    ? 'border-primary/50 bg-primary/10 text-foreground'
                    : 'border-border/60 bg-background text-muted-foreground hover:border-border'
                } ${isLoadingVisibleProviders ? 'opacity-50' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={isVisible}
                  disabled={isLoadingVisibleProviders || isOnlyVisible}
                  onChange={(e) => handleToggleAgentVisibility(agent, e.target.checked)}
                  className="sr-only"
                />
                <span
                  className={`h-3 w-3 rounded-sm border ${
                    isVisible
                      ? 'border-primary bg-primary'
                      : 'border-muted-foreground/50 bg-background'
                  } flex items-center justify-center`}
                >
                  {isVisible && (
                    <svg
                      className="h-2 w-2 text-primary-foreground"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                <span>{AGENT_NAMES[agent]}</span>
                {isOnlyVisible && (
                  <span className="text-[10px] text-muted-foreground/60">
                    ({t('agents.visibility.required', { defaultValue: 'required' })})
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </div>

      <AgentSelectorSection
        agents={visibleAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        agentContextById={agentContextById}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        <AgentCategoryTabsSection
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
        />

        <AgentCategoryContentSection
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          agentContextById={agentContextById}
          claudePermissions={claudePermissions}
          onClaudePermissionsChange={onClaudePermissionsChange}
          cursorPermissions={cursorPermissions}
          onCursorPermissionsChange={onCursorPermissionsChange}
          codexPermissionMode={codexPermissionMode}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          geminiPermissionMode={geminiPermissionMode}
          onGeminiPermissionModeChange={onGeminiPermissionModeChange}
          projects={projects}
        />
      </div>
    </div>
  );
}
