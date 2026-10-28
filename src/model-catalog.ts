/** Builds a provider's model list from its OpenAI-compatible `/models` catalog. */

import type {
	CatalogModel,
	CatalogRefreshContext,
	ProviderEntry,
	RefreshedModels,
} from "./provider-config.ts";
import { DEFAULT_API, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "./provider-config.ts";

export class ModelCatalog {
	private readonly entry: ProviderEntry;

	constructor(entry: ProviderEntry) {
		this.entry = entry;
	}

	async models(context: CatalogRefreshContext): Promise<RefreshedModels> {
		const stored = [...(context.stored?.models ?? [])];
		const apiKey = ModelCatalog.apiKey(context.credential, this.entry.apiKey);
		if (!apiKey || !context.allowNetwork) {
			return stored;
		}
		const response = await fetch(`${this.entry.baseUrl}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: context.signal,
		});
		if (!response.ok) {
			throw new Error(this.failure(`returned HTTP ${response.status}`));
		}
		const catalog = (await response.json()) as { data?: CatalogModel[] };
		if (!Array.isArray(catalog.data)) {
			throw new Error(this.failure("has no model list"));
		}
		const models = catalog.data.map((model) => this.toModel(model));
		await context.publish({ persist: { models, checkedAt: Date.now() } });
		return models;
	}

	private toModel(model: CatalogModel): RefreshedModels[number] {
		return {
			id: model.id,
			name: model.display_name ?? model.id,
			api: DEFAULT_API,
			reasoning: Boolean(model.reasoning?.effort_levels?.length),
			input: model.vision ? ["text", "image"] : ["text"],
			contextWindow: model.context_window ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	}

	/** A stored key wins; otherwise an `$ENV` reference or a literal from the file. */
	private static apiKey(credential: { type: string; key?: string } | undefined, configured: string | undefined): string | undefined {
		if (credential?.type === "api_key") {
			return credential.key;
		}
		const variable = configured?.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1];
		return variable ? process.env[variable] : configured;
	}

	private failure(problem: string): string {
		return `${this.entry.name ?? this.entry.baseUrl}: model catalog ${problem}`;
	}
}
