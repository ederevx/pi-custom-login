/** Registers providers with pi and their response-start fallbacks. */

import type { ExtensionAPI, ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";

import { DEFAULT_API, type ProviderEntry } from "./provider-config.ts";
import { ModelCatalog } from "./model-catalog.ts";
import { ProviderFallback, type FallbackRegistry } from "./provider-fallback.ts";

type BoundRegistry = FallbackRegistry & Pick<ModelRegistry, "getAll">;

export class ProviderRegistry {
	private readonly fallback = new ProviderFallback();
	private registry: BoundRegistry | undefined;

	constructor(private readonly pi: ExtensionAPI) {}

	bindSession(registry: BoundRegistry): void {
		this.registry = registry;
		this.fallback.bindRegistry(registry);
	}

	/** One catalog snapshot for the fallback picker. */
	catalog() {
		return this.registry?.getAll().map((model) => ({
			provider: model.provider,
			id: model.id,
			api: model.api,
			type: model.type,
			contextWindow: model.contextWindow,
			input: [...model.input],
		}));
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

	/** A re-registration merges over the old one, so a dropped field would survive. */
	replace(id: string, entry: ProviderEntry): void {
		this.pi.unregisterProvider(id);
		this.register(id, entry);
	}

	remove(id: string): void {
		this.pi.unregisterProvider(id);
	}

	private config(id: string, entry: ProviderEntry, catalog: ModelCatalog): ProviderConfig {
		return {
			name: entry.name ?? id,
			baseUrl: entry.baseUrl,
			api: DEFAULT_API,
			authHeader: true,
			models: [],
			refreshModels: (context) => catalog.models(context),
			...(entry.fallback
				? {
					streamSimple: (model, context, options) =>
						this.fallback.stream(model, context, options, entry.fallback!),
				}
				: {}),
		};
	}
}
