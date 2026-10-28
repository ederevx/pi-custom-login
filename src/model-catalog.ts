/** Builds a provider's model list from its OpenAI-compatible `/models` catalog. */

import { CatalogEntry } from "./catalog-entry.ts";
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
		const data = (catalog as { data?: unknown } | null)?.data;
		if (!Array.isArray(data)) {
			throw this.failure("has no model list");
		}
		return data.map((entry) => new CatalogEntry(entry, this.label()).model());
	}

	private label(): string {
		return this.entry.name ?? this.entry.baseUrl;
	}

	private failure(problem: string): Error {
		return new Error(`${this.label()}: model catalog ${problem}`);
	}
}
