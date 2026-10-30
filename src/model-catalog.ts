/** Builds a provider's model list from its OpenAI-compatible `/models` catalog. */

import { CatalogEntry } from "./catalog-entry.ts";
import { CatalogMetadata } from "./catalog-metadata.ts";
import type { CatalogRefreshContext, ProviderEntry, RefreshedModels } from "./provider-config.ts";

export class ModelCatalog {
	private readonly entry: ProviderEntry;

	constructor(entry: ProviderEntry) {
		this.entry = entry;
	}

	async models(context: CatalogRefreshContext): Promise<RefreshedModels> {
		const stored = [...(context.stored?.models ?? [])];
		const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
		if (!apiKey || !context.allowNetwork) {
			return stored;
		}
		const response = await fetch(`${this.entry.baseUrl}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: context.signal,
		});
		if (!response.ok) {
			throw this.failure(`returned HTTP ${response.status}`);
		}
		const models = this.parse(await response.json());
		await context.publish({ persist: { models, checkedAt: Date.now() } });
		return models;
	}

	/** Everything is validated before anything is persisted. */
	private parse(catalog: unknown): RefreshedModels {
		const body = (catalog ?? {}) as { data?: unknown; models?: unknown };
		if (!Array.isArray(body.data)) {
			throw this.failure("has no model list");
		}
		const metadata = new CatalogMetadata(body.models, this.label());
		const ids = new Set<string>();
		return body.data.map((value) => {
			const entry = new CatalogEntry(value, this.label());
			const id = entry.id();
			if (ids.has(id)) {
				throw this.failure(`has a duplicate model id ${id}`);
			}
			ids.add(id);
			return entry.model(metadata.for(id));
		});
	}

	private label(): string {
		return this.entry.name ?? this.entry.baseUrl;
	}

	private failure(problem: string): Error {
		return new Error(`${this.label()}: model catalog ${problem}`);
	}
}
