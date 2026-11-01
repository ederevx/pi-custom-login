/** Builds a provider's model list from its OpenAI-compatible `/models` catalog. */

import { CatalogEntry } from "./catalog-entry.ts";
import { CatalogMetadata } from "./catalog-metadata.ts";
import type { CatalogRefreshContext, ModelOverride, ProviderEntry, RefreshedModels } from "./provider-config.ts";

export class ModelCatalog {
	/** The only override keys the catalog recognizes; anything else is a stored mistake. */
	private static readonly FIELDS = new Set(["name", "reasoning", "contextWindow", "maxTokens", "cost"]);
	private static readonly COST_FIELDS = new Set(["input", "output", "cacheRead", "cacheWrite"]);

	private readonly entry: ProviderEntry;

	constructor(entry: ProviderEntry) {
		this.entry = entry;
	}

	async models(context: CatalogRefreshContext): Promise<RefreshedModels> {
		this.validateOverrides();
		const stored = [...(context.stored?.models ?? [])];
		const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
		if (!apiKey || !context.allowNetwork) {
			return this.applyOverrides(stored);
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
		return this.applyOverrides(models);
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

	/** Overrides sit below pi's models.json modelOverrides and re-derive only fields the catalog supplied. */
	private applyOverrides(models: RefreshedModels): RefreshedModels {
		const overrides = this.entry.modelOverrides;
		if (!overrides) {
			return models;
		}
		return models.map((model) => {
			const override = overrides[model.id];
			if (!override) {
				return model;
			}
			const cost = override.cost && model.cost
				? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
				}
				: model.cost;
			return {
				...model,
				...(override.name !== undefined ? { name: override.name } : {}),
				...(override.reasoning !== undefined ? { reasoning: override.reasoning } : {}),
				...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
				...(override.maxTokens !== undefined ? { maxTokens: override.maxTokens } : {}),
				...(override.cost !== undefined ? { cost } : {}),
			};
		});
	}

	/** Overrides are validated before any fetch or publish, like the catalog itself. */
	private validateOverrides(): void {
		const overrides = this.entry.modelOverrides;
		if (!overrides) {
			return;
		}
		for (const [id, override] of Object.entries(overrides)) {
			this.validateOverride(id, override);
		}
	}

	private validateOverride(id: string, override: ModelOverride): void {
		for (const key of Object.keys(override)) {
			if (!ModelCatalog.FIELDS.has(key)) {
				throw this.failure(`has an unknown modelOverrides.${id}.${key}`);
			}
		}
		if (override.name !== undefined && (typeof override.name !== "string" || override.name.trim() === "")) {
			throw this.failure(`has an invalid modelOverrides.${id}.name`);
		}
		if (override.reasoning !== undefined && typeof override.reasoning !== "boolean") {
			throw this.failure(`has an invalid modelOverrides.${id}.reasoning`);
		}
		if (override.contextWindow !== undefined) {
			this.limit(override.contextWindow, `modelOverrides.${id}.contextWindow`);
		}
		if (override.maxTokens !== undefined) {
			this.limit(override.maxTokens, `modelOverrides.${id}.maxTokens`);
		}
		if (override.cost !== undefined) {
			for (const key of Object.keys(override.cost)) {
				if (!ModelCatalog.COST_FIELDS.has(key)) {
					throw this.failure(`has an unknown modelOverrides.${id}.cost.${key}`);
				}
			}
			this.validateCost(override.cost.input, `modelOverrides.${id}.cost.input`);
			this.validateCost(override.cost.output, `modelOverrides.${id}.cost.output`);
			this.validateCost(override.cost.cacheRead, `modelOverrides.${id}.cost.cacheRead`);
			this.validateCost(override.cost.cacheWrite, `modelOverrides.${id}.cost.cacheWrite`);
		}
	}

	private limit(value: unknown, field: string): number {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
			throw this.failure(`has an invalid ${field}`);
		}
		return value;
	}

	private validateCost(value: unknown, field: string): void {
		if (value === undefined) {
			return;
		}
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw this.failure(`has an invalid ${field}`);
		}
	}
}
