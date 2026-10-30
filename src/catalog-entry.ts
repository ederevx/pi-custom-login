/** Turns one `/models` catalog entry into a pi model, refusing unusable ones. */

import { DEFAULT_API, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, type RefreshedModels } from "./provider-config.ts";

export class CatalogEntry {
	private readonly fields: Record<string, unknown>;
	private readonly label: string;

	constructor(value: unknown, label: string) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`${label}: model catalog has a malformed model entry`);
		}
		this.fields = value as Record<string, unknown>;
		this.label = label;
	}

	/** A value the entry itself carries wins; metadata only fills what it omits. */
	model(metadata?: Record<string, unknown>): RefreshedModels[number] {
		const id = this.id();
		return {
			id,
			name: this.text(this.fields, "display_name") ?? this.text(metadata, "display_name", true) ?? id,
			api: DEFAULT_API,
			reasoning: this.reasoning(metadata),
			input: (this.optionalBoolean("vision") ?? this.metadataVision(metadata)) === true ? ["text", "image"] : ["text"],
			contextWindow: this.contextWindow(metadata),
			maxTokens: this.limit(this.fields, "max_output_tokens") ?? this.limit(metadata, "max_output_tokens") ?? DEFAULT_MAX_TOKENS,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	}

	id(): string {
		const id = this.fields.id;
		if (typeof id !== "string" || id.trim() === "") {
			throw this.failure("has a model entry without an id");
		}
		return id;
	}

	/** `context_window` is the effective window; `max_context_window` only stands in for it. */
	private contextWindow(metadata: Record<string, unknown> | undefined): number {
		const declared = this.limit(this.fields, "context_window");
		if (declared !== undefined) {
			return declared;
		}
		const window = this.limit(metadata, "context_window");
		const ceiling = this.limit(metadata, "max_context_window");
		if (window !== undefined && ceiling !== undefined && window > ceiling) {
			throw this.failure("advertises a context window above its max_context_window");
		}
		return window ?? ceiling ?? DEFAULT_CONTEXT_WINDOW;
	}

	/** A declared `reasoning` object settles the question for the entry itself. */
	private reasoning(metadata: Record<string, unknown> | undefined): boolean {
		if (this.fields.reasoning !== undefined) {
			return this.effortLevels().length > 0;
		}
		return this.metadataEfforts(metadata).some((effort) => effort !== "none");
	}

	private limit(source: Record<string, unknown> | undefined, field: string): number | undefined {
		const value = source?.[field];
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
			throw this.failure(`has an invalid ${field}`);
		}
		return value;
	}

	private text(source: Record<string, unknown> | undefined, field: string, blankIsAbsent = false): string | undefined {
		const value = source?.[field];
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== "string") {
			throw this.failure(`has a non-string ${field}`);
		}
		return blankIsAbsent && value.trim() === "" ? undefined : value;
	}

	private optionalBoolean(field: string): boolean | undefined {
		const value = this.fields[field];
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== "boolean") {
			throw this.failure(`has a non-boolean ${field}`);
		}
		return value;
	}

	private metadataVision(metadata: Record<string, unknown> | undefined): boolean | undefined {
		const modalities = metadata?.input_modalities;
		if (modalities === undefined) {
			return undefined;
		}
		if (!Array.isArray(modalities) || !modalities.every((modality) => typeof modality === "string")) {
			throw this.failure("has an invalid input_modalities");
		}
		return modalities.includes("image");
	}

	private metadataEfforts(metadata: Record<string, unknown> | undefined): string[] {
		const levels = metadata?.supported_reasoning_levels;
		if (levels === undefined) {
			return [];
		}
		if (!Array.isArray(levels)) {
			throw this.failure("has an invalid supported_reasoning_levels");
		}
		return levels.map((level) => {
			const effort = typeof level === "object" && level !== null ? (level as Record<string, unknown>).effort : undefined;
			if (typeof effort !== "string" || effort.trim() === "") {
				throw this.failure("has an invalid supported_reasoning_levels entry");
			}
			return effort;
		});
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
