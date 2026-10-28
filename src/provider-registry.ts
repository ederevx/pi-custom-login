/** Registers providers with pi and refreshes their model lists on demand. */

import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

import { DEFAULT_API, type ProviderEntry } from "./provider-config.ts";
import { ModelCatalog } from "./model-catalog.ts";

export class ProviderRegistry {
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	registerAll(providers: Record<string, ProviderEntry>): void {
		for (const [id, entry] of Object.entries(providers)) {
			this.register(id, entry);
		}
	}

	register(id: string, entry: ProviderEntry): void {
		const catalog = new ModelCatalog(entry);
		this.pi.registerProvider(id, this.config(id, entry, catalog));
	}

	remove(id: string): void {
		this.pi.unregisterProvider(id);
	}

	private config(id: string, entry: ProviderEntry, catalog: ModelCatalog): ProviderConfig {
		return {
			name: entry.name ?? id,
			baseUrl: entry.baseUrl,
			api: DEFAULT_API,
			...(entry.apiKey === undefined ? {} : { apiKey: entry.apiKey }),
			authHeader: true,
			models: [],
			refreshModels: (context) => catalog.models(context),
		};
	}
}
