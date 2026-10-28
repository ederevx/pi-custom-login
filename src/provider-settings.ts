/** Validates stored fallback settings and lists the models one may fall back to. */

import {
	MAX_TIMEOUT_MS,
	type ModelRef,
	type ProviderFallbackConfig,
} from "./provider-config.ts";

/** One catalog entry the fallback picker reads. */
export interface CatalogEntry {
	provider: string;
	id: string;
	api: string;
	type?: string;
	contextWindow: number;
	input: readonly string[];
}

export class ProviderSettings {
	/** Validates a stored draft; an unusable one disables fallback without blocking registration. */
	static normalize(value: unknown): ProviderFallbackConfig | undefined {
		if (typeof value !== "object" || value === null) {
			return undefined;
		}
		const draft = value as Record<string, unknown>;
		const model = ProviderSettings.ref(draft.model);
		if (!model || !ProviderSettings.validTimeout(draft.timeoutMs)) {
			return undefined;
		}
		return { model, timeoutMs: draft.timeoutMs as number };
	}

	/** An entered timeout, or undefined when it is not a whole number of milliseconds. */
	static parseTimeout(value: string): number | undefined {
		const parsed = Number(value.trim());
		return ProviderSettings.validTimeout(parsed) ? parsed : undefined;
	}

	static validTimeout(value: unknown): boolean {
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS;
	}

	static usable(entry: CatalogEntry, source: CatalogEntry): boolean {
		return entry.api !== "pi-virtual" && entry.provider !== source.provider &&
			ProviderSettings.chat(entry) &&
			entry.contextWindow >= source.contextWindow &&
			source.input.every((modality) => entry.input.includes(modality));
	}

	/** The models of other providers a provider's requests may fall back to. */
	static candidates(providerId: string, catalog: readonly CatalogEntry[]): ModelRef[] {
		const sources = catalog.filter((entry) => entry.provider === providerId && ProviderSettings.chat(entry));
		return catalog
			.filter((entry) => entry.provider !== providerId && ProviderSettings.chat(entry))
			.filter((entry) => sources.every((source) => ProviderSettings.usable(entry, source)))
			.map(({ provider, id }) => ({ provider, id }));
	}

	/** `provider/id`, the only shape shown to the user. */
	static label(model: ModelRef): string {
		return `${model.provider}/${model.id}`;
	}

	private static chat(entry: CatalogEntry): boolean {
		return entry.api !== "pi-virtual" && (entry.type === undefined || entry.type === "chat");
	}

	private static ref(value: unknown): ModelRef | undefined {
		if (typeof value !== "object" || value === null) {
			return undefined;
		}
		const draft = value as Record<string, unknown>;
		if (typeof draft.provider !== "string" || draft.provider === "" || typeof draft.id !== "string" || draft.id === "") {
			return undefined;
		}
		return { provider: draft.provider, id: draft.id };
	}
}
