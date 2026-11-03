/** Validates one stored model override against the fields pi accepts. */

import type { ModelOverride } from "./provider-config.ts";

export class ModelOverrideRules {
	private static readonly FIELDS = new Set([
		"name",
		"reasoning",
		"thinkingLevelMap",
		"input",
		"inputLimits",
		"cost",
		"promptCache",
		"contextWindow",
		"maxTokens",
		"samplingParams",
		"samplingParamsByThinkingLevel",
		"headers",
		"compat",
	]);
	private static readonly COST_FIELDS = new Set(["input", "output", "cacheRead", "cacheWrite", "tiers"]);
	private static readonly TIER_FIELDS = ["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"];
	private static readonly INPUT_LIMIT_FIELDS = new Set(["maxRequestBytes", "images"]);
	private static readonly IMAGE_LIMIT_FIELDS = new Set(["resize", "maxPerMessage", "maxPerRequest"]);
	private static readonly RESIZE_LIMIT_FIELDS = new Set(["maxWidth", "maxHeight", "maxBytes", "jpegQuality"]);
	private static readonly MODALITIES = new Set(["text", "image"]);

	private readonly failure: (problem: string) => Error;

	constructor(failure: (problem: string) => Error) {
		this.failure = failure;
	}

	validate(id: string, override: ModelOverride): void {
		const fields = this.record(override, `modelOverrides.${id}`);
		for (const key of Object.keys(fields)) {
			if (!ModelOverrideRules.FIELDS.has(key)) {
				throw this.failure(`has an unknown modelOverrides.${id}.${key}`);
			}
		}
		if (fields.name !== undefined && (typeof fields.name !== "string" || fields.name.trim() === "")) {
			throw this.failure(`has an invalid modelOverrides.${id}.name`);
		}
		if (fields.reasoning !== undefined && typeof fields.reasoning !== "boolean") {
			throw this.failure(`has an invalid modelOverrides.${id}.reasoning`);
		}
		this.thinkingLevelMap(fields.thinkingLevelMap, `modelOverrides.${id}.thinkingLevelMap`);
		this.input(fields.input, `modelOverrides.${id}.input`);
		this.inputLimits(fields.inputLimits, `modelOverrides.${id}.inputLimits`);
		if (fields.contextWindow !== undefined) {
			this.limit(fields.contextWindow, `modelOverrides.${id}.contextWindow`);
		}
		if (fields.maxTokens !== undefined) {
			this.limit(fields.maxTokens, `modelOverrides.${id}.maxTokens`);
		}
		this.cost(fields.cost, `modelOverrides.${id}.cost`);
		this.counts(fields.promptCache, `modelOverrides.${id}.promptCache`);
		if (fields.samplingParams !== undefined) {
			this.record(fields.samplingParams, `modelOverrides.${id}.samplingParams`);
		}
		if (fields.samplingParamsByThinkingLevel !== undefined) {
			const level = `modelOverrides.${id}.samplingParamsByThinkingLevel`;
			for (const [name, params] of Object.entries(this.record(fields.samplingParamsByThinkingLevel, level))) {
				this.record(params, `${level}.${name}`);
			}
		}
		if (fields.headers !== undefined) {
			for (const [name, value] of Object.entries(this.record(fields.headers, `modelOverrides.${id}.headers`))) {
				if (typeof value !== "string") {
					throw this.failure(`has an invalid modelOverrides.${id}.headers.${name}`);
				}
			}
		}
		if (fields.compat !== undefined) {
			this.record(fields.compat, `modelOverrides.${id}.compat`);
		}
	}

	private thinkingLevelMap(value: unknown, field: string): void {
		if (value === undefined) {
			return;
		}
		for (const [level, mapped] of Object.entries(this.record(value, field))) {
			if (mapped !== null && typeof mapped !== "string") {
				throw this.failure(`has an invalid ${field}.${level}`);
			}
		}
	}

	/** `text` is what every model accepts; `image` is the only optional modality pi defines. */
	private input(value: unknown, field: string): void {
		if (value === undefined) {
			return;
		}
		if (!Array.isArray(value) || value.length === 0 || !value.includes("text") || new Set(value).size !== value.length
			|| !value.every((modality) => typeof modality === "string" && ModelOverrideRules.MODALITIES.has(modality))) {
			throw this.failure(`has an invalid ${field}`);
		}
	}

	private inputLimits(value: unknown, field: string): void {
		if (value === undefined) {
			return;
		}
		const limits = this.record(value, field);
		for (const key of Object.keys(limits)) {
			if (!ModelOverrideRules.INPUT_LIMIT_FIELDS.has(key)) {
				throw this.failure(`has an unknown ${field}.${key}`);
			}
		}
		if (limits.maxRequestBytes !== undefined) {
			this.limit(limits.maxRequestBytes, `${field}.maxRequestBytes`);
		}
		if (limits.images === undefined) {
			return;
		}
		const images = this.record(limits.images, `${field}.images`);
		for (const key of Object.keys(images)) {
			if (!ModelOverrideRules.IMAGE_LIMIT_FIELDS.has(key)) {
				throw this.failure(`has an unknown ${field}.images.${key}`);
			}
		}
		for (const key of ["maxPerMessage", "maxPerRequest"]) {
			if (images[key] !== undefined) {
				this.limit(images[key], `${field}.images.${key}`);
			}
		}
		if (images.resize === undefined) {
			return;
		}
		const resize = this.record(images.resize, `${field}.images.resize`);
		for (const key of Object.keys(resize)) {
			if (!ModelOverrideRules.RESIZE_LIMIT_FIELDS.has(key)) {
				throw this.failure(`has an unknown ${field}.images.resize.${key}`);
			}
		}
		for (const [key, entry] of Object.entries(resize)) {
			this.limit(entry, `${field}.images.resize.${key}`);
		}
	}

	private cost(value: unknown, field: string): void {
		if (value === undefined) {
			return;
		}
		const cost = this.record(value, field);
		for (const key of Object.keys(cost)) {
			if (!ModelOverrideRules.COST_FIELDS.has(key)) {
				throw this.failure(`has an unknown ${field}.${key}`);
			}
		}
		for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
			this.costValue(cost[key], `${field}.${key}`);
		}
		if (cost.tiers !== undefined) {
			this.tiers(cost.tiers, `${field}.tiers`);
		}
	}

	/** pi requires every price of a tier, so a partial tier is a stored mistake. */
	private tiers(value: unknown, field: string): void {
		if (!Array.isArray(value)) {
			throw this.failure(`has an invalid ${field}`);
		}
		for (const [index, entry] of value.entries()) {
			const tier = this.record(entry, `${field}.${index}`);
			for (const key of Object.keys(tier)) {
				if (!ModelOverrideRules.TIER_FIELDS.includes(key)) {
					throw this.failure(`has an unknown ${field}.${index}.${key}`);
				}
			}
			if (typeof tier.inputTokensAbove !== "number" || !Number.isSafeInteger(tier.inputTokensAbove) || tier.inputTokensAbove < 0) {
				throw this.failure(`has an invalid ${field}.${index}.inputTokensAbove`);
			}
			for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
				this.costValue(tier[key], `${field}.${index}.${key}`);
				if (tier[key] === undefined) {
					throw this.failure(`has an invalid ${field}.${index}.${key}`);
				}
			}
		}
	}

	private counts(value: unknown, field: string): void {
		if (value === undefined) {
			return;
		}
		for (const [key, seconds] of Object.entries(this.record(value, field))) {
			if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
				throw this.failure(`has an invalid ${field}.${key}`);
			}
		}
	}

	private record(value: unknown, field: string): Record<string, unknown> {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw this.failure(`has an invalid ${field}`);
		}
		return value as Record<string, unknown>;
	}

	private limit(value: unknown, field: string): number {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
			throw this.failure(`has an invalid ${field}`);
		}
		return value;
	}

	private costValue(value: unknown, field: string): void {
		if (value === undefined) {
			return;
		}
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw this.failure(`has an invalid ${field}`);
		}
	}
}
