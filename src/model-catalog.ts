/** Builds a provider's model list from its OpenAI-compatible `/models` catalog. */

import { CatalogEntry } from "./catalog-entry.ts";
import { CatalogMetadata } from "./catalog-metadata.ts";
import { ModelOverrideRules } from "./model-override-rules.ts";
import type { CatalogRefreshContext, ProviderEntry, RefreshedModels } from "./provider-config.ts";

export class ModelCatalog {
	/** Override keys pi merges field by field over the model's value instead of replacing it. */
	private static readonly MERGED = new Set([
		"cost",
		"compat",
		"inputLimits",
		"promptCache",
		"samplingParams",
		"samplingParamsByThinkingLevel",
		"headers",
		"thinkingLevelMap",
	]);

	private readonly entry: ProviderEntry;

	constructor(entry: ProviderEntry) {
		this.entry = entry;
	}

	async models(context: CatalogRefreshContext): Promise<RefreshedModels> {
		this.validateOverrides();
		const stored = [...(context.stored?.models ?? [])];
		const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
		if (!apiKey || !context.allowNetwork) {
			return this.applyOverrides(this.baseline(stored));
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
		return this.applyOverrides(this.baseline(models));
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

	/** The extension claims only OpenAI compatibility, whose instruction role is
	 *  `system`; pi otherwise guesses `developer` for an unrecognized base URL,
	 *  which several OpenAI-compatible servers (DeepSeek among them) reject. The
	 *  saved list stays raw, so the key is re-applied on every return. */
	private baseline(models: RefreshedModels): RefreshedModels {
		return models.map((model) => ({ ...model, compat: { supportsDeveloperRole: false, ...model.compat } }));
	}

	private failure(problem: string): Error {
		return new Error(`${this.label()}: model catalog ${problem}`);
	}

	/** Overrides sit below pi's models.json modelOverrides and set any field of the model. */
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
			const merged: Record<string, unknown> = { ...model };
			for (const [key, value] of Object.entries(override)) {
				// The fallback is a choice this extension makes at send time, not a field pi knows.
				if (key === "fallback") {
					continue;
				}
				merged[key] = ModelCatalog.MERGED.has(key) ? { ...(merged[key] as object | undefined), ...(value as object) } : value;
			}
			return merged as RefreshedModels[number];
		});
	}

	/** Overrides are validated before any fetch or publish, like the catalog itself. */
	private validateOverrides(): void {
		const overrides = this.entry.modelOverrides;
		if (!overrides) {
			return;
		}
		const rules = new ModelOverrideRules((problem) => this.failure(problem));
		for (const [id, override] of Object.entries(overrides)) {
			rules.validate(id, override);
		}
	}
}
