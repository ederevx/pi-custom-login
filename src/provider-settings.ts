/** Validates fallback settings loaded from disk and edits them through prompts. */

import { isModelType } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	DEFAULT_FALLBACK_TIMEOUT_MS,
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
		const timeoutMs = draft.timeoutMs;
		if (!model) {
			return undefined;
		}
		if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
			return undefined;
		}
		return { model, timeoutMs };
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

	static usable(entry: CatalogEntry, source: CatalogEntry): boolean {
		return entry.api !== "pi-virtual" && entry.provider !== source.provider &&
			(entry.type === undefined || entry.type === "chat") &&
			entry.contextWindow >= source.contextWindow &&
			source.input.every((modality) => entry.input.includes(modality));
	}

	/** Offers Disabled plus every eligible model; undefined means cancel, null means disabled. */
	static async pick(
		providerId: string,
		stored: ProviderFallbackConfig | undefined,
		catalog: CatalogEntry[] | undefined,
		ctx: ExtensionCommandContext,
	): Promise<ProviderFallbackConfig | null | undefined> {
		if (!catalog) {
			ctx.ui.notify("Model catalog unavailable; fallback unchanged", "warning");
			return undefined;
		}
		const sources = catalog.filter((entry) =>
			entry.provider === providerId && entry.api !== "pi-virtual" && (entry.type === undefined || entry.type === "chat"),
		);
		const options = new Map<string, ModelRef>();
		const labels: string[] = ["Disabled"];
		for (const entry of catalog) {
			if (entry.provider === providerId || entry.api === "pi-virtual" || (entry.type !== undefined && entry.type !== "chat")) {
				continue;
			}
			if (!sources.every((source) => ProviderSettings.usable(entry, source))) {
				continue;
			}
			const label = `${entry.provider}/${entry.id}`;
			options.set(label, { provider: entry.provider, id: entry.id });
			labels.push(label);
		}
		const saved = stored ? `${stored.model.provider}/${stored.model.id}` : undefined;
		if (saved && !options.has(saved)) {
			labels.push(`${saved} (saved)`);
		}
		const chosen = await ctx.ui.select(`Fallback for ${providerId} (when the response does not start in time)`, labels);
		if (chosen === undefined) {
			return undefined;
		}
		if (chosen === "Disabled") {
			return null;
		}
		const suffix = " (saved)";
		const bare = chosen.endsWith(suffix) ? chosen.slice(0, -suffix.length) : chosen;
		const model = options.get(bare) ?? stored?.model;
		if (!model) {
			return undefined;
		}
		const previous = stored && `${stored.model.provider}/${stored.model.id}` === bare ? String(stored.timeoutMs) : String(DEFAULT_FALLBACK_TIMEOUT_MS);
		const answered = await ctx.ui.input("Response-start timeout (ms)", previous);
		if (answered === undefined) {
			return undefined;
		}
		const timeoutMs = Number(answered);
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
			ctx.ui.notify(`Timeout must be a whole number between 1 and ${MAX_TIMEOUT_MS}`, "warning");
			return undefined;
		}
		return { model, timeoutMs };
	}
}
