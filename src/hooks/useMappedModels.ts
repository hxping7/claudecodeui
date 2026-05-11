import { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch } from '../utils/api';

export type MappedModel = {
  value: string;
  label: string;
  envKey: string | null;
  actualModel: string | null;
};

export type ProviderModels = {
  models: MappedModel[];
  defaultModel?: string;
  defaultActualModel?: string;
};

type MappedModelsConfig = {
  claude: ProviderModels;
  cursor: ProviderModels;
  codex: ProviderModels;
  gemini: ProviderModels;
};

const DEFAULT_MODELS: MappedModelsConfig = {
  claude: { models: [] },
  cursor: { models: [] },
  codex: { models: [] },
  gemini: { models: [] },
};

/**
 * Hook to fetch mapped models from provider settings.json files
 * Returns models with actual model names mapped from environment variables
 */
export function useMappedModels() {
  const [mappedModels, setMappedModels] = useState<MappedModelsConfig>(DEFAULT_MODELS);
  const [isLoading, setIsLoading] = useState(true);

  const fetchMappedModels = useCallback(async () => {
    try {
      setIsLoading(true);
      // Use authenticated endpoint that uses current user's home directory
      const response = await authenticatedFetch('/api/models');
      const data = await response.json();
      if (data.success && data.models) {
        // API returns arrays directly, wrap them with models property
        setMappedModels({
          claude: { models: data.models.claude || [] },
          cursor: { models: data.models.cursor || [] },
          codex: { models: data.models.codex || [] },
          gemini: { models: data.models.gemini || [] },
        });
      }
    } catch (error) {
      console.error('Failed to fetch mapped models:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMappedModels();
  }, [fetchMappedModels]);

  return {
    mappedModels,
    isLoading,
    refreshMappedModels: fetchMappedModels,
  };
}

export default useMappedModels;
