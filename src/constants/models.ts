import type { AIProvider } from '../types';

export interface ModelOption {
  value: string;
  label: string;
}

const codexOptions: ModelOption[] = [
  { value: '', label: 'Default' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'gpt-5-mini', label: 'GPT-5 mini' },
];

const claudeOptions: ModelOption[] = [
  { value: '', label: 'Default' },
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { value: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
  { value: 'claude-3-7-sonnet-latest', label: 'Claude 3.7 Sonnet' },
];

const geminiOptions: ModelOption[] = [
  { value: '', label: 'Default' },
];

export const MODEL_OPTIONS_BY_PROVIDER: Record<AIProvider, ModelOption[]> = {
  codex: codexOptions,
  claude: claudeOptions,
  gemini: geminiOptions,
};

export function getSessionModelLabel(provider: AIProvider, model?: string | null): string {
  const options = MODEL_OPTIONS_BY_PROVIDER[provider];
  if (!model) {
    if (provider === 'claude') return 'Claude (Default)';
    if (provider === 'gemini') return 'Gemini (Default)';
    return 'Codex (Default)';
  }

  const normalized = model.trim();
  if (!normalized) {
    if (provider === 'claude') return 'Claude (Default)';
    if (provider === 'gemini') return 'Gemini (Default)';
    return 'Codex (Default)';
  }

  const option = options.find((item) => item.value === normalized);
  return option?.label ?? normalized;
}
