import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check } from 'lucide-react';
import { useMappedModels } from '../../../../hooks/useMappedModels';
import type { LLMProvider } from '../../../types/app';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import {
  CLAUDE_MODELS,
  CURSOR_MODELS,
  CODEX_MODELS,
  GEMINI_MODELS,
} from '../../../../../shared/modelConstants';

type ModelSelectorProps = {
  provider: LLMProvider;
  currentModel: string;
  onModelChange: (model: string) => void;
  disabled?: boolean;
};

function getStaticModels(provider: LLMProvider) {
  if (provider === 'claude') return CLAUDE_MODELS.OPTIONS;
  if (provider === 'codex') return CODEX_MODELS.OPTIONS;
  if (provider === 'gemini') return GEMINI_MODELS.OPTIONS;
  return CURSOR_MODELS.OPTIONS;
}

export default function ModelSelector({
  provider,
  currentModel,
  onModelChange,
  disabled = false,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownContentRef = useRef<HTMLDivElement>(null);
  const { mappedModels } = useMappedModels();

  // Get models - use mapped models if available, otherwise use static
  const models = mappedModels[provider]?.models?.length > 0
    ? mappedModels[provider].models
    : getStaticModels(provider);

  // Find current model label
  const currentModelLabel = models.find(
    (m: { value: string; label: string }) => m.value === currentModel
  )?.label || currentModel;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideTrigger = dropdownRef.current?.contains(target);
      const isInsideDropdown = dropdownContentRef.current?.contains(target);
      if (dropdownRef.current && !isInsideTrigger && !isInsideDropdown) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (modelValue: string) => {
    onModelChange(modelValue);
    setIsOpen(false);
  };

  const dropdownContent = isOpen && !disabled ? (
    <div
      ref={dropdownContentRef}
      className="fixed z-[9999] max-h-64 min-w-[180px] overflow-y-auto rounded-lg border border-border/60 bg-card shadow-lg"
      style={{
        bottom: dropdownRef.current
          ? window.innerHeight - dropdownRef.current.getBoundingClientRect().top + window.scrollY + 4 + 'px'
          : 'auto',
        top: 'unset',
        left: dropdownRef.current
          ? dropdownRef.current.getBoundingClientRect().left + window.scrollX + 'px'
          : 'auto',
      }}
    >
      {models.map((model: { value: string; label: string }) => (
        <button
          key={model.value}
          type="button"
          onClick={() => handleSelect(model.value)}
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
            model.value === currentModel
              ? 'bg-primary/10 text-primary'
              : 'text-foreground hover:bg-muted'
          }`}
        >
          <span className="flex-1 truncate">{model.label}</span>
          {model.value === currentModel && (
            <Check className="h-3 w-3 shrink-0 text-primary" />
          )}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition-all duration-200 ${
          disabled
            ? 'cursor-not-allowed border-border/40 bg-muted/30 text-muted-foreground/50'
            : 'cursor-pointer border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted'
        }`}
        title={disabled ? 'Model selection disabled during active session' : 'Select model'}
      >
        <SessionProviderLogo provider={provider} className="h-3.5 w-3.5" />
        <span className="max-w-[120px] truncate">{currentModelLabel}</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {typeof document !== 'undefined' && createPortal(dropdownContent, document.body)}
    </div>
  );
}
