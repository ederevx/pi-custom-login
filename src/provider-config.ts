/** Shared constants and the shapes stored in the provider file. */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const AGENT_DIR_VARIABLE = "PI_CODING_AGENT_DIR";
export const CONFIG_FILE = "custom-providers.json";
export const COMMAND_NAME = "providers";
export const DEFAULT_API = "openai-completions";
export const CONTEXT_WINDOW_VARIABLE = "PI_CUSTOM_LOGIN_DEFAULT_CONTEXT_WINDOW";
export const MAX_TOKENS_VARIABLE = "PI_CUSTOM_LOGIN_DEFAULT_MAX_TOKENS";

/**
 * The limits used when a catalog omits them. They are assumptions about the
 * endpoint, not verified model limits, so they are configurable.
 */
export class FallbackLimits {
	static contextWindow(): number {
		return FallbackLimits.read(CONTEXT_WINDOW_VARIABLE, 131072);
	}

	static maxTokens(): number {
		return FallbackLimits.read(MAX_TOKENS_VARIABLE, 16384);
	}

	private static read(variable: string, fallback: number): number {
		const configured = process.env[variable];
		if (configured === undefined) {
			return fallback;
		}
		const value = Number(configured);
		if (!/^[1-9]\d*$/.test(configured) || !Number.isSafeInteger(value)) {
			throw new Error(`${variable} is set but invalid; expected a positive safe integer. Unset it to use the default.`);
		}
		return value;
	}
}

export const DEFAULT_CONTEXT_WINDOW = FallbackLimits.contextWindow();
export const DEFAULT_MAX_TOKENS = FallbackLimits.maxTokens();

/** One provider as the user registered it. */
export interface ProviderEntry {
	name?: string;
	baseUrl: string;
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
