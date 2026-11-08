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
			name:
				this.text(this.fields, "display_name") ??
				this.text(this.fields, "name", true) ??
				this.text(metadata, "display_name", true) ??
				id,
			api: DEFAULT_API,
			reasoning: this.reasoning(metadata),
			input: this.imageSupport(metadata) === true ? ["text", "image"] : ["text"],
			contextWindow: this.contextWindow(metadata),
			maxTokens: this.maxTokens(metadata),
			cost: this.cost(),
		};
	}

	id(): string {
		const id = this.fields.id;
		if (typeof id !== "string" || id.trim() === "") {
			throw this.failure("has a model entry without an id");
		}
		return id;
	}

	/** `context_window` is the effective window; `limit.context` and `context_length`
	 *  are the same limit under other names. `max_context_window` is a ceiling and only
	 *  stands in when no effective window is declared. */
	private contextWindow(metadata: Record<string, unknown> | undefined): number {
		const declared = this.firstLimit(["context_window"], ["limit", "context"], ["context_length"]);
		if (declared !== undefined) {
			return declared;
		}
		const window = this.limit(metadata, "context_window");
		const ceiling = this.limit(metadata, "max_context_window");
		if (window !== undefined && ceiling !== undefined && window > ceiling) {
			throw this.failure("advertises a context window above its max_context_window");
		}
		return window ?? this.firstLimit(["max_context_window"]) ?? ceiling ?? DEFAULT_CONTEXT_WINDOW;
	}

	/** `max_output_tokens` is the flat name; `limit.output` and `max_output_length`
	 *  are the same cap under other names, and only stand in for it. */
	private maxTokens(metadata: Record<string, unknown> | undefined): number {
		const declared = this.firstLimit(["max_output_tokens"], ["limit", "output"], ["max_output_length"]);
		return declared ?? this.limit(metadata, "max_output_tokens") ?? DEFAULT_MAX_TOKENS;
	}

	/** A declared reasoning shape settles the question for the entry itself. */
	private reasoning(metadata: Record<string, unknown> | undefined): boolean {
		const declared = this.declaredReasoning();
		if (declared !== undefined) {
			return declared;
		}
		if (this.features()?.includes("reasoning") === true) {
			return true;
		}
		return this.metadataEfforts(metadata).some((effort) => effort !== "none");
	}

	/** `reasoning` wins over `capabilities.reasoning`, which is read only when it is reached. */
	private declaredReasoning(): boolean | undefined {
		if (this.fields.reasoning !== undefined) {
			return this.declaredFlag(this.fields.reasoning, "reasoning");
		}
		const nested = this.at(["capabilities"])?.reasoning;
		return nested === undefined ? undefined : this.declaredFlag(nested, "capabilities.reasoning");
	}

	/** A declared reasoning shape - a flag, or an object whose levels may be spelled
	 *  `effort_levels` or `effort` - settles it, and an explicit `supported` flag wins. */
	private declaredFlag(declared: unknown, label: string): boolean {
		if (declared === null) {
			return false;
		}
		if (typeof declared === "boolean") {
			return declared;
		}
		if (typeof declared !== "object" || Array.isArray(declared)) {
			throw this.failure(`has an invalid ${label}`);
		}
		const shape = declared as Record<string, unknown>;
		const supported = this.optionalBoolean(shape, "supported");
		const levels = shape.effort_levels ?? shape.effort;
		if (levels !== undefined && (!Array.isArray(levels) || !levels.every((level) => typeof level === "string"))) {
			throw this.failure("has an invalid reasoning effort list");
		}
		if (supported !== undefined) {
			return supported;
		}
		return Array.isArray(levels) && levels.length > 0;
	}

	/** `vision` is the flat flag; a modality list names the same capability. */
	private imageSupport(metadata: Record<string, unknown> | undefined): boolean | undefined {
		return (
			this.optionalBoolean(this.fields, "vision") ??
			this.modalities(this.fields.input_modalities, "input_modalities") ??
			this.modalities(this.at(["modalities"])?.input, "modalities.input") ??
			this.modalities(metadata?.input_modalities, "input_modalities")
		);
	}

	/** A modality list names image support as `image` or as image MIME types. */
	private modalities(value: unknown, label: string): boolean | undefined {
		if (value === undefined) {
			return undefined;
		}
		if (!Array.isArray(value) || !value.every((modality) => typeof modality === "string")) {
			throw this.failure(`has an invalid ${label}`);
		}
		return value.some((modality) => modality === "image" || modality.startsWith("image/"));
	}

	/** Some catalogs list capabilities as feature names instead of objects. */
	private features(): string[] | undefined {
		const features = this.fields.supported_features;
		if (features === undefined) {
			return undefined;
		}
		if (!Array.isArray(features) || !features.every((feature) => typeof feature === "string")) {
			throw this.failure("has an invalid supported_features");
		}
		return features;
	}

	/** Prices are USD per token in a router's `pricing` object and already USD per
	 *  million tokens in the `cost.text` one; either way pi wants the latter. */
	private cost(): RefreshedModels[number]["cost"] {
		const pricing = this.at(["pricing"]);
		if (pricing !== undefined) {
			return {
				input: this.price(pricing, "prompt"),
				output: this.price(pricing, "completion"),
				cacheRead: this.price(pricing, "input_cache_read"),
				cacheWrite: this.price(pricing, "input_cache_write"),
			};
		}
		return {
			input: this.money(this.at(["cost", "text", "input"])?.price, "cost.text.input.price"),
			output: this.money(this.at(["cost", "text", "output"])?.price, "cost.text.output.price"),
			cacheRead: this.money(this.at(["cost", "text", "input", "cache"])?.read, "cost.text.input.cache.read"),
			cacheWrite: this.money(this.at(["cost", "text", "input", "cache"])?.write, "cost.text.input.cache.write"),
		};
	}

	private price(source: Record<string, unknown> | undefined, field: string): number {
		const value = this.text(source, field);
		// The catalog's "-1" sentinel supplies no fixed price.
		if (value === undefined || value === "-1") {
			return 0;
		}
		const price = Number(value) * 1_000_000;
		if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(price)) {
			throw this.failure(`has an invalid pricing.${field}`);
		}
		return price;
	}

	/** A per-million price is already a number; conditional overrides beside it are ignored. */
	private money(value: unknown, label: string): number {
		if (value === undefined) {
			return 0;
		}
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw this.failure(`has an invalid ${label}`);
		}
		return value;
	}

	/** The first declared limit wins and is validated like a flat field; a candidate is
	 *  read only when reached, so a shape nothing consumed never invalidates the entry. */
	private firstLimit(...paths: string[][]): number | undefined {
		for (const path of paths) {
			const container = path.length === 1 ? this.fields : this.at(path.slice(0, -1));
			const value = this.limit(container, path[path.length - 1]);
			if (value !== undefined) {
				return value;
			}
		}
		return undefined;
	}

	/** A nested object the entry carries; any level that is present but not an object is invalid. */
	private at(path: string[]): Record<string, unknown> | undefined {
		let container: Record<string, unknown> = this.fields;
		for (const [index, key] of path.entries()) {
			const value = container[key];
			if (value === undefined) {
				return undefined;
			}
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw this.failure(`has an invalid ${path.slice(0, index + 1).join(".")}`);
			}
			container = value as Record<string, unknown>;
		}
		return container;
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

	private optionalBoolean(source: Record<string, unknown>, field: string): boolean | undefined {
		const value = source[field];
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== "boolean") {
			throw this.failure(`has a non-boolean ${field}`);
		}
		return value;
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

	private failure(problem: string): Error {
		return new Error(`${this.label}: model catalog ${problem}`);
	}
}
