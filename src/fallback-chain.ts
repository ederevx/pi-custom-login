/** Follows stored fallbacks across this extension's providers; a model without one ends a chain. */

import type { ModelFallback, ProviderEntry } from "./provider-config.ts";

export class FallbackChain {
	private readonly providers: Record<string, ProviderEntry>;

	constructor(providers: Record<string, ProviderEntry>) {
		this.providers = providers;
	}

	next(provider: string, model: string): ModelFallback | undefined {
		return this.providers[provider]?.modelOverrides?.[model]?.fallback;
	}

	/** Whether following the chain from this model returns to a model already on it, itself included. */
	loops(provider: string, model: string): boolean {
		const seen = new Set<string>();
		for (let hop: ModelFallback | undefined = { provider, model }; hop !== undefined; hop = this.next(hop.provider, hop.model)) {
			const key = JSON.stringify([hop.provider, hop.model]);
			if (seen.has(key)) {
				return true;
			}
			seen.add(key);
		}
		return false;
	}
}
