import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import type { AgentProvider } from '../components/settings/types/types';

const DEFAULT_VISIBLE_PROVIDERS: AgentProvider[] = ['claude', 'cursor', 'codex', 'gemini', 'tokenc'];

type VisibleProvidersResponse = {
  success: boolean;
  visibleProviders: AgentProvider[];
};

/**
 * Hook to fetch and manage visible providers configuration from the server.
 * This configuration controls which AI agents are shown in the UI.
 */
export function useVisibleProviders(): {
  visibleProviders: AgentProvider[];
  isLoading: boolean;
  setVisibleProviders: (providers: AgentProvider[]) => Promise<boolean>;
  refreshVisibleProviders: () => Promise<void>;
} {
  const [visibleProviders, setVisibleProvidersState] = useState<AgentProvider[]>(DEFAULT_VISIBLE_PROVIDERS);
  const [isLoading, setIsLoading] = useState(true);

  const fetchVisibleProviders = async () => {
    try {
      const response = await authenticatedFetch('/api/settings/visible-providers');
      if (response.ok) {
        const data = (await response.json()) as VisibleProvidersResponse;
        if (data.success && Array.isArray(data.visibleProviders)) {
          setVisibleProvidersState(data.visibleProviders);
        }
      }
    } catch (error) {
      console.error('Error fetching visible providers:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const setVisibleProviders = async (providers: AgentProvider[]): Promise<boolean> => {
    try {
      const response = await authenticatedFetch('/api/settings/visible-providers', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ visibleProviders: providers }),
      });

      if (response.ok) {
        const data = (await response.json()) as VisibleProvidersResponse;
        if (data.success) {
          setVisibleProvidersState(data.visibleProviders);
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error('Error saving visible providers:', error);
      return false;
    }
  };

  useEffect(() => {
    void fetchVisibleProviders();
  }, []);

  return {
    visibleProviders,
    isLoading,
    setVisibleProviders,
    refreshVisibleProviders: fetchVisibleProviders,
  };
}
