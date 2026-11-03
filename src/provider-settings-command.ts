/** The `/providers-settings` command: edit or clear per-model overrides for a registered provider. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { FallbackChain } from "./fallback-chain.ts";
import { ModelOverrideRules } from "./model-override-rules.ts";
import { COMMAND_NAME_SETTINGS, type ModelFallback, type ModelOverride, type ModelOverrides, type ProviderEntry } from "./provider-config.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import { ProviderStore } from "./provider-store.ts";

interface EditableField {
	readonly label: string;
	readonly kind: "text" | "boolean" | "limit" | "cost" | "modalities" | "json" | "fallback";
	readonly path: readonly string[];
}

export class ProviderSettingsCommand {
	/** The fields of pi's model configuration, in the order its documentation lists them. */
	private static readonly FIELDS: readonly EditableField[] = [
		{ label: "name", kind: "text", path: ["name"] },
		{ label: "reasoning", kind: "boolean", path: ["reasoning"] },
		{ label: "thinkingLevelMap", kind: "json", path: ["thinkingLevelMap"] },
		{ label: "input", kind: "modalities", path: ["input"] },
		{ label: "inputLimits", kind: "json", path: ["inputLimits"] },
		{ label: "cost.input", kind: "cost", path: ["cost", "input"] },
		{ label: "cost.output", kind: "cost", path: ["cost", "output"] },
		{ label: "cost.cacheRead", kind: "cost", path: ["cost", "cacheRead"] },
		{ label: "cost.cacheWrite", kind: "cost", path: ["cost", "cacheWrite"] },
		{ label: "cost.tiers", kind: "json", path: ["cost", "tiers"] },
		{ label: "promptCache", kind: "json", path: ["promptCache"] },
		{ label: "contextWindow", kind: "limit", path: ["contextWindow"] },
		{ label: "maxTokens", kind: "limit", path: ["maxTokens"] },
		{ label: "samplingParams", kind: "json", path: ["samplingParams"] },
		{ label: "samplingParamsByThinkingLevel", kind: "json", path: ["samplingParamsByThinkingLevel"] },
		{ label: "headers", kind: "json", path: ["headers"] },
		{ label: "compat", kind: "json", path: ["compat"] },
		{ label: "fallback", kind: "fallback", path: ["fallback"] },
	];
	private static readonly MODALITIES = new Map([["text", ["text"]], ["text, image", ["text", "image"]]]);

	private static readonly EDIT = "Edit a field";
	private static readonly CLEAR_FIELD = "Clear a field";
	private static readonly CLEAR = "Clear this model's override";
	private static readonly MANUAL = "Enter a model id";

	private readonly pi: ExtensionAPI;
	private readonly store: ProviderStore;
	private readonly registry: ProviderRegistry;

	constructor(pi: ExtensionAPI, store: ProviderStore, registry: ProviderRegistry) {
		this.pi = pi;
		this.store = store;
		this.registry = registry;
	}

	register(): void {
		this.pi.registerCommand(COMMAND_NAME_SETTINGS, {
			description: "Edit model overrides for registered providers",
			handler: (args, ctx) => this.run(args, ctx),
		});
	}

	private async run(args: string, ctx: ExtensionCommandContext): Promise<void> {
		void args;
		const providers = this.store.all();
		const ids = Object.keys(providers);
		if (ids.length === 0) {
			ctx.ui.notify("No custom providers; add one with /providers add", "warning");
			return;
		}
		const providerId = await this.chooseProvider(ids, providers, ctx);
		if (!providerId) {
			return;
		}
		const modelId = await this.chooseModel(providerId, ctx);
		if (!modelId) {
			return;
		}
		const actions = [ProviderSettingsCommand.EDIT, ProviderSettingsCommand.CLEAR_FIELD, ProviderSettingsCommand.CLEAR];
		const action = await ctx.ui.select(`${providerId} / ${modelId}`, actions);
		if (!action) {
			return;
		}
		if (action === ProviderSettingsCommand.CLEAR) {
			this.clear(providerId, providers[providerId], modelId, ctx);
			return;
		}
		if (action === ProviderSettingsCommand.CLEAR_FIELD) {
			await this.clearField(providerId, providers[providerId], modelId, ctx);
			return;
		}
		await this.edit(providerId, providers[providerId], modelId, ctx);
	}

	private async chooseProvider(ids: string[], providers: Record<string, ProviderEntry>, ctx: ExtensionCommandContext): Promise<string | undefined> {
		const labels = new Map(ids.map((id) => [`${id} ${providers[id].baseUrl}`, id]));
		const choice = await ctx.ui.select("Provider", [...labels.keys()]);
		return choice === undefined ? undefined : labels.get(choice);
	}

	private async chooseModel(providerId: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
		const models = ctx.modelRegistry.getModelsOfType("chat", providerId);
		if (models.length === 0) {
			ctx.ui.notify(`No models known for ${providerId} yet; its catalog has not been fetched`, "info");
			return this.manualModel(providerId, ctx);
		}
		const labels = new Map(models.map((model) => [`${model.id} — ${model.name}`, model.id]));
		const choice = await ctx.ui.select("Model", [...labels.keys(), ProviderSettingsCommand.MANUAL]);
		if (choice === undefined) {
			return undefined;
		}
		if (choice === ProviderSettingsCommand.MANUAL) {
			return this.manualModel(providerId, ctx);
		}
		return labels.get(choice);
	}

	private async manualModel(providerId: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
		const modelId = (await ctx.ui.input("Model id"))?.trim() || undefined;
		if (modelId === undefined) {
			return undefined;
		}
		if (ctx.modelRegistry.getModelOfType("chat", providerId, modelId) === undefined) {
			ctx.ui.notify(`${modelId} is not in the catalog yet; the override does nothing until the catalog returns it`, "warning");
		}
		return modelId;
	}

	private async edit(providerId: string, entry: ProviderEntry, modelId: string, ctx: ExtensionCommandContext): Promise<void> {
		const choice = await ctx.ui.select("Field", ProviderSettingsCommand.FIELDS.map((field) => field.label));
		const field = ProviderSettingsCommand.FIELDS.find((candidate) => candidate.label === choice);
		if (!field) {
			return;
		}
		const value = await this.value(field, providerId, modelId, ctx);
		if (value === null) {
			return;
		}
		if (value === undefined) {
			ctx.ui.notify(`${field.label} expects ${ProviderSettingsCommand.expectation(field)}`, "warning");
			return;
		}
		const next = this.assign(this.override(providerId, modelId), field, value);
		if (this.save(providerId, entry, modelId, next, ctx)) {
			ctx.ui.notify(`Saved ${field.label} for ${modelId}; open /model to apply`, "info");
		}
	}

	private async clearField(providerId: string, entry: ProviderEntry, modelId: string, ctx: ExtensionCommandContext): Promise<void> {
		const override = this.override(providerId, modelId);
		const fields = ProviderSettingsCommand.FIELDS.filter((field) => ProviderSettingsCommand.at(override, field.path) !== undefined);
		if (fields.length === 0) {
			ctx.ui.notify(`${modelId} has no override to clear; edit one first`, "info");
			return;
		}
		const choice = await ctx.ui.select("Field to clear", fields.map((field) => field.label));
		const field = fields.find((candidate) => candidate.label === choice);
		if (!field) {
			return;
		}
		if (this.save(providerId, entry, modelId, ProviderSettingsCommand.without(override, field.path), ctx)) {
			ctx.ui.notify(`Cleared ${field.label} for ${modelId}; open /model to apply`, "info");
		}
	}

	private async value(field: EditableField, providerId: string, modelId: string, ctx: ExtensionCommandContext): Promise<unknown> {
		if (field.kind === "fallback") {
			return this.chooseFallback(ctx);
		}
		const current = this.current(field, providerId, modelId, ctx);
		if (field.kind === "boolean") {
			const choice = await ctx.ui.select(`${field.label} (current: ${current})`, ["true", "false"]);
			return choice === undefined ? null : choice === "true";
		}
		if (field.kind === "modalities") {
			const choice = await ctx.ui.select(`${field.label} (current: ${current})`, [...ProviderSettingsCommand.MODALITIES.keys()]);
			return choice === undefined ? null : ProviderSettingsCommand.MODALITIES.get(choice);
		}
		const answer = (await ctx.ui.input(`${field.label}${current === "" ? "" : ` (current: ${current})`}`))?.trim();
		if (answer === undefined) {
			return null;
		}
		if (answer === "") {
			return undefined;
		}
		if (field.kind === "text" || field.kind === "json") {
			return field.kind === "text" ? answer : ProviderSettingsCommand.parse(answer);
		}
		const number = Number(answer);
		if (field.kind === "limit") {
			return /^[1-9]\d*$/.test(answer) && Number.isSafeInteger(number) ? number : undefined;
		}
		return /^\d+(?:\.\d+)?$/.test(answer) && Number.isFinite(number) ? number : undefined;
	}

	private static parse(answer: string): unknown {
		try {
			return JSON.parse(answer);
		} catch {
			return undefined;
		}
	}

	/** Only a chat model with credentials can serve the turn, so only its provider is offered. */
	private async chooseFallback(ctx: ExtensionCommandContext): Promise<ModelFallback | null> {
		const available = await ctx.modelRegistry.getAvailableOfType("chat");
		const providers = [...new Set(available.map((model) => model.provider))];
		if (providers.length === 0) {
			ctx.ui.notify("No provider with credentials has a chat model to fall back to", "warning");
			return null;
		}
		const labels = new Map(providers.map((id) => [`${id} ${ctx.modelRegistry.getProviderDisplayName(id)}`, id]));
		const choice = await ctx.ui.select("Fallback provider", [...labels.keys()]);
		if (choice === undefined) {
			return null;
		}
		const provider = labels.get(choice);
		if (provider === undefined) {
			return null;
		}
		const model = await this.chooseModel(provider, ctx);
		return model === undefined ? null : { provider, model };
	}

	/** The override value when one is set, else the registry's effective value. */
	private current(field: EditableField, providerId: string, modelId: string, ctx: ExtensionCommandContext): string {
		const override = ProviderSettingsCommand.at(this.override(providerId, modelId), field.path);
		const value = override !== undefined ? override : ProviderSettingsCommand.at(ctx.modelRegistry.getModelOfType("chat", providerId, modelId), field.path);
		if (value === undefined) {
			return "";
		}
		if (field.kind === "modalities" && Array.isArray(value)) {
			return value.join(", ");
		}
		return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
	}

	private static expectation(field: EditableField): string {
		if (field.kind === "limit") {
			return "a positive integer";
		}
		if (field.kind === "cost") {
			return "a non-negative USD-per-million-tokens number";
		}
		if (field.kind === "boolean") {
			return "true or false";
		}
		if (field.kind === "json") {
			return "valid JSON";
		}
		return "a non-empty string";
	}

	private clear(providerId: string, entry: ProviderEntry, modelId: string, ctx: ExtensionCommandContext): void {
		if (this.save(providerId, entry, modelId, {}, ctx)) {
			ctx.ui.notify(`Cleared the override for ${modelId}; open /model to apply`, "info");
		}
	}

	private override(providerId: string, modelId: string): ModelOverride {
		return { ...(this.store.all()[providerId]?.modelOverrides?.[modelId] ?? {}) };
	}

	private static at(source: unknown, path: readonly string[]): unknown {
		let value = source;
		for (const key of path) {
			if (typeof value !== "object" || value === null) {
				return undefined;
			}
			value = (value as Record<string, unknown>)[key];
		}
		return value;
	}

	private assign(override: ModelOverride, field: EditableField, value: unknown): ModelOverride {
		const [parent, child] = field.path;
		const next = { ...override } as Record<string, unknown>;
		if (child === undefined) {
			next[parent] = value;
		} else {
			next[parent] = { ...(next[parent] as object | undefined), [child]: value };
		}
		return next as ModelOverride;
	}

	private static without(override: ModelOverride, path: readonly string[]): ModelOverride {
		const [parent, child] = path;
		const next = { ...override } as Record<string, unknown>;
		if (child === undefined) {
			delete next[parent];
			return next as ModelOverride;
		}
		const group = { ...(next[parent] as Record<string, unknown>) };
		delete group[child];
		if (Object.keys(group).length === 0) {
			delete next[parent];
		} else {
			next[parent] = group;
		}
		return next as ModelOverride;
	}

	/** An override left empty is dropped, and an empty override map leaves the provider file. */
	private save(providerId: string, entry: ProviderEntry, modelId: string, next: ModelOverride, ctx: ExtensionCommandContext): boolean {
		if (!this.valid(modelId, next, ctx)) {
			return false;
		}
		const overrides: ModelOverrides = { ...(entry.modelOverrides ?? {}) };
		if (Object.keys(next).length === 0) {
			delete overrides[modelId];
		} else {
			overrides[modelId] = next;
		}
		const updated: ProviderEntry = { ...entry };
		if (Object.keys(overrides).length === 0) {
			delete updated.modelOverrides;
		} else {
			updated.modelOverrides = overrides;
		}
		if (new FallbackChain({ ...this.store.all(), [providerId]: updated }).loops(providerId, modelId)) {
			ctx.ui.notify(`${modelId} cannot fall back to a model that already falls back to it`, "warning");
			return false;
		}
		this.store.add(providerId, updated);
		this.registry.replace(providerId, updated);
		return true;
	}

	/** The same rules the catalog applies, so an edit cannot store what a refresh would reject. */
	private valid(modelId: string, next: ModelOverride, ctx: ExtensionCommandContext): boolean {
		try {
			new ModelOverrideRules((problem) => new Error(`Cannot save the override: it ${problem}`)).validate(modelId, next);
			return true;
		} catch (error) {
			ctx.ui.notify((error as Error).message, "warning");
			return false;
		}
	}
}
