import { useState, useEffect, useCallback } from 'react';

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
      // Use public endpoint that doesn't require authentication
      const response = await fetch('/api/public/models');
      const data = await response.json();
      if (data.success && data.models) {
        setMappedModels({
          claude: data.models.claude || { models: [] },
          cursor: data.models.cursor || { models: [] },
          codex: data.models.codex || { models: [] },
          gemini: data.models.gemini || { models: [] },
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
