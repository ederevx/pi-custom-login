/** Shared constants and the shapes stored in the provider file. */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const AGENT_DIR_VARIABLE = "PI_CODING_AGENT_DIR";
export const CONFIG_FILE = "custom-providers.json";
export const COMMAND_NAME = "providers";
export const DEFAULT_API = "openai-completions";
export const DEFAULT_CONTEXT_WINDOW = 131072;
export const DEFAULT_MAX_TOKENS = 16384;

/** One provider as the user registered it. */
export interface ProviderEntry {
	name?: string;
	baseUrl: string;
	apiKey?: string;
}

/** The catalog fields a `/models` response may carry. */
export interface CatalogModel {
	id: string;
	display_name?: string;
	context_window?: number;
	vision?: boolean;
	reasoning?: { effort_levels?: string[] };
}

/** The part of pi's refresh context this extension uses. */
export interface CatalogRefreshContext {
	credential?: { type: string; key?: string };
	stored?: { models: readonly ProviderModelConfig[] };
	allowNetwork: boolean;
	signal: AbortSignal;
	publish(publication: { persist: { models: readonly ProviderModelConfig[]; checkedAt: number } }): Promise<boolean>;
}

export type RefreshedModels = ProviderModelConfig[];
