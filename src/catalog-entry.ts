/** Turns one `/models` catalog entry into a pi model, refusing unusable ones. */

import { DEFAULT_API, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, type RefreshedModels } from "./provider-config.ts";

export class CatalogEntry {
	private readonly fields: Record<string, unknown>;
	private readonly label: string;

	constructor(value: unknown, label: string) {
		if (typeof value !== "object" || value === null) {
			throw new Error(`${label}: model catalog has a malformed model entry`);
		}
		this.fields = value as Record<string, unknown>;
		this.label = label;
	}

	model(): RefreshedModels[number] {
		return {
			id: this.id(),
			name: this.optionalString("display_name") ?? this.id(),
			api: DEFAULT_API,
			reasoning: this.effortLevels().length > 0,
			input: this.optionalBoolean("vision") ? ["text", "image"] : ["text"],
			contextWindow: this.optionalNumber("context_window") ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: this.optionalNumber("max_output_tokens") ?? DEFAULT_MAX_TOKENS,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	}

	private id(): string {
		const id = this.fields.id;
		if (typeof id !== "string" || id.trim() === "") {
			throw this.failure("has a model entry without an id");
		}
		return id;
	}

	private optionalString(field: string): string | undefined {
		const value = this.fields[field];
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== "string") {
			throw this.failure(`has a non-string ${field}`);
		}
		return value;
	}

	private optionalBoolean(field: string): boolean {
		const value = this.fields[field];
		if (value === undefined) {
			return false;
		}
		if (typeof value !== "boolean") {
			throw this.failure(`has a non-boolean ${field}`);
		}
		return value;
	}

	private optionalNumber(field: string): number | undefined {
		const value = this.fields[field];
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw this.failure(`has an invalid ${field}`);
		}
		return value;
	}

	private effortLevels(): unknown[] {
		const reasoning = this.fields.reasoning;
		if (reasoning === undefined || reasoning === null) {
			return [];
		}
		if (typeof reasoning !== "object" || Array.isArray(reasoning)) {
			throw this.failure("has an invalid reasoning");
		}
		const levels = (reasoning as Record<string, unknown>).effort_levels;
		if (levels === undefined) {
			return [];
		}
		if (!Array.isArray(levels) || !levels.every((level) => typeof level === "string")) {
			throw this.failure("has an invalid reasoning.effort_levels");
		}
		return levels;
	}

	private failure(problem: string): Error {
		return new Error(`${this.label}: model catalog ${problem}`);
	}
}
