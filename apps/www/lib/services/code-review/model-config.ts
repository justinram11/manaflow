import type { ModelConfig } from "./run-simple-anthropic-review";

type SearchParamsRecord = {
  [key: string]: string | string[] | undefined;
};

export const HEATMAP_MODEL_QUERY_KEY = "model";
export const HEATMAP_MODEL_FINETUNE_QUERY_VALUE = "finetune";
export const HEATMAP_MODEL_ANTHROPIC_QUERY_VALUE = "anthropic";
export type HeatmapModelQueryValue =
  | typeof HEATMAP_MODEL_FINETUNE_QUERY_VALUE
  | typeof HEATMAP_MODEL_ANTHROPIC_QUERY_VALUE;

const FINE_TUNED_OPENAI_MODEL_ID =
  "ft:gpt-4.1-mini-2025-04-14:lawrence:cmux-heatmap-sft:CZW6Lc77";
const ANTHROPIC_OPUS_MODEL_ID = "claude-opus-4-1-20250805";

function createFineTunedOpenAiConfig(): ModelConfig {
  return {
    provider: "openai",
    model: FINE_TUNED_OPENAI_MODEL_ID,
  };
}

function createAnthropicOpusConfig(): ModelConfig {
  return {
    provider: "anthropic",
    model: ANTHROPIC_OPUS_MODEL_ID,
  };
}

export function getDefaultHeatmapModelConfig(): ModelConfig {
  return createFineTunedOpenAiConfig();
}

export function getHeatmapModelConfigForSelection(
  selection: HeatmapModelQueryValue
): ModelConfig {
  if (selection === HEATMAP_MODEL_ANTHROPIC_QUERY_VALUE) {
    return createAnthropicOpusConfig();
  }
  return createFineTunedOpenAiConfig();
}

export function normalizeHeatmapModelQueryValue(
  raw: string | null | undefined
): HeatmapModelQueryValue {
  if (typeof raw !== "string") {
    return HEATMAP_MODEL_FINETUNE_QUERY_VALUE;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === HEATMAP_MODEL_ANTHROPIC_QUERY_VALUE) {
    return HEATMAP_MODEL_ANTHROPIC_QUERY_VALUE;
  }
  if (normalized === HEATMAP_MODEL_FINETUNE_QUERY_VALUE) {
    return HEATMAP_MODEL_FINETUNE_QUERY_VALUE;
  }
  return HEATMAP_MODEL_FINETUNE_QUERY_VALUE;
}

function extractRecordValue(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function resolveModelSelectionFromRecord(
  searchParams: SearchParamsRecord
): HeatmapModelQueryValue {
  if ("ft0" in searchParams) {
    return HEATMAP_MODEL_FINETUNE_QUERY_VALUE;
  }
  const raw = extractRecordValue(searchParams[HEATMAP_MODEL_QUERY_KEY]);
  return normalizeHeatmapModelQueryValue(raw ?? null);
}

function resolveModelSelectionFromUrlSearchParams(
  searchParams: URLSearchParams
): HeatmapModelQueryValue {
  if (searchParams.has("ft0")) {
    return HEATMAP_MODEL_FINETUNE_QUERY_VALUE;
  }
  return normalizeHeatmapModelQueryValue(
    searchParams.get(HEATMAP_MODEL_QUERY_KEY)
  );
}

export function parseModelConfigFromRecord(
  searchParams: SearchParamsRecord
): ModelConfig | undefined {
  const selection = resolveModelSelectionFromRecord(searchParams);
  return getHeatmapModelConfigForSelection(selection);
}

export function parseModelConfigFromUrlSearchParams(
  searchParams: URLSearchParams
): ModelConfig | undefined {
  const selection = resolveModelSelectionFromUrlSearchParams(searchParams);
  return getHeatmapModelConfigForSelection(selection);
}
