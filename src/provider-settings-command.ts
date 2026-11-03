/** The `/providers-settings` command: edit or clear per-model overrides for a registered provider. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";

import { FallbackChain } from "./fallback-chain.ts";
import { ModelOverrideRules } from "./model-override-rules.ts";
import { COMMAND_NAME_SETTINGS, type ModelFallback, type ModelOverride, type ModelOverrides, type ProviderEntry } from "./provider-config.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import { ProviderStore } from "./provider-store.ts";
import { SettingsDialogs, type SettingRow } from "./settings-dialogs.ts";

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

	private static readonly EDIT_VALUE = "Edit value";
	private static readonly CHOOSE_FALLBACK = "Choose a model";
	private static readonly CLEAR_FIELD = "Clear override";
	private static readonly OVERRIDE = "override";
	private static readonly CLEAR = "Clear this model's override";
	private static readonly MANUAL_VALUE = "";
	private static readonly MANUAL_ITEM: SelectItem = { value: ProviderSettingsCommand.MANUAL_VALUE, label: "Enter a model id" };
	private static readonly UNSET = "not set";
	private static readonly OVERRIDDEN = "Overridden for this model";
	private static readonly CATALOG = "From the provider catalog";
	private static readonly OVERRIDE_HINT = "Remove every stored value for this model";

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

	/**
	 * Provider, model and field screens, with the path to the current one kept here: a screen
	 * answered with nothing steps back a level, and only the provider screen can end the command.
	 */
	private async run(args: string, ctx: ExtensionCommandContext): Promise<void> {
		void args;
		const providers = this.store.all();
		const ids = Object.keys(providers);
		if (ids.length === 0) {
			ctx.ui.notify("No custom providers; add one with /providers add", "warning");
			return;
		}
		const dialogs = new SettingsDialogs(ctx);
		const path: string[] = [];
		let selected: string | undefined;
		for (;;) {
			const [providerId, modelId] = path;
			const answer =
				providerId === undefined
					? await this.chooseProvider(dialogs, ids, providers, selected)
					: modelId === undefined
						? await this.chooseModel(providerId, dialogs, ctx, selected)
						: await this.changeField(providerId, modelId, dialogs, ctx, selected);
			if (answer === undefined) {
				if (path.length === 0) {
					return;
				}
				selected = path.pop();
				continue;
			}
			if (path.length < 2) {
				path.push(answer);
				selected = undefined;
			} else {
				selected = answer;
			}
		}
	}

	private async chooseProvider(dialogs: SettingsDialogs, ids: readonly string[], providers: Record<string, ProviderEntry>, selected?: string): Promise<string | undefined> {
		const entries = ids.map((id) => {
			const baseUrl = providers[id]?.baseUrl ?? "";
			return { item: { value: id, label: id, description: baseUrl }, search: `${id} ${baseUrl}` };
		});
		return dialogs.pick("Provider", entries, [], false, selected);
	}

	private async chooseModel(providerId: string, dialogs: SettingsDialogs, ctx: ExtensionCommandContext, selected?: string): Promise<string | undefined> {
		const models = ctx.modelRegistry.getModelsOfType("chat", providerId);
		if (models.length === 0) {
			ctx.ui.notify(`No models known for ${providerId} yet; its catalog has not been fetched`, "info");
			return this.manualModel(providerId, ctx);
		}
		const entries = models.map((model) => ({
			item: { value: model.id, label: model.id, description: model.name },
			search: ProviderSettingsCommand.searchText(providerId, model.id, model.name),
		}));
		let cursor = selected;
		for (;;) {
			const choice = await dialogs.pick("Model", entries, [ProviderSettingsCommand.MANUAL_ITEM], true, cursor);
			if (choice === undefined) {
				return undefined;
			}
			if (choice !== ProviderSettingsCommand.MANUAL_VALUE) {
				return choice;
			}
			const manual = await this.manualModel(providerId, ctx);
			if (manual !== undefined) {
				return manual;
			}
			cursor = undefined;
		}
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

	/** Every field of the model with the value it currently resolves to, plus the whole override row. */
	private rows(providerId: string, modelId: string, ctx: ExtensionCommandContext): SettingRow[] {
		const override = this.override(providerId, modelId);
		const rows = ProviderSettingsCommand.FIELDS.map((field) => {
			const stored = ProviderSettingsCommand.at(override, field.path) !== undefined;
			const choices = [...ProviderSettingsCommand.choices(field), ...(stored ? [ProviderSettingsCommand.CLEAR_FIELD] : [])];
			return {
				label: field.label,
				value: this.display(field, providerId, modelId, ctx),
				description: stored ? ProviderSettingsCommand.OVERRIDDEN : ProviderSettingsCommand.CATALOG,
				choices,
			};
		});
		const count = Object.keys(override).length;
		rows.push({
			label: ProviderSettingsCommand.OVERRIDE,
			value: count === 0 ? ProviderSettingsCommand.UNSET : `${count} ${count === 1 ? "field" : "fields"}`,
			description: ProviderSettingsCommand.OVERRIDE_HINT,
			choices: [ProviderSettingsCommand.CLEAR],
		});
		return rows;
	}

	/** The field screen stays open on the row it was left on, whatever the chosen value did. */
	private async changeField(providerId: string, modelId: string, dialogs: SettingsDialogs, ctx: ExtensionCommandContext, selected: string | undefined): Promise<string | undefined> {
		const rows = this.rows(providerId, modelId, ctx);
		const answer = await dialogs.settings(`${providerId} / ${modelId}`, rows, selected);
		if (answer === undefined) {
			return undefined;
		}
		await this.apply(answer.label, answer.choice, providerId, modelId, dialogs, ctx);
		return answer.label;
	}

	private async apply(label: string, choice: string, providerId: string, modelId: string, dialogs: SettingsDialogs, ctx: ExtensionCommandContext): Promise<void> {
		if (label === ProviderSettingsCommand.OVERRIDE) {
			this.commit(providerId, modelId, {}, ctx, `Cleared the override for ${modelId}`);
			return;
		}
		const field = ProviderSettingsCommand.FIELDS.find((candidate) => candidate.label === label);
		if (field === undefined) {
			return;
		}
		if (choice === ProviderSettingsCommand.CLEAR_FIELD) {
			this.commit(providerId, modelId, ProviderSettingsCommand.without(this.override(providerId, modelId), field.path), ctx, `Cleared ${field.label} for ${modelId}`);
			return;
		}
		const value = await this.value(field, choice, providerId, modelId, dialogs, ctx);
		if (value === null) {
			return;
		}
		if (value === undefined) {
			ctx.ui.notify(`${field.label} expects ${ProviderSettingsCommand.expectation(field)}`, "warning");
			return;
		}
		this.commit(providerId, modelId, this.assign(this.override(providerId, modelId), field, value), ctx, `Saved ${field.label} for ${modelId}`);
	}

	/** The value the chosen option stands for; null steps back and undefined is input that cannot be stored. */
	private async value(field: EditableField, choice: string, providerId: string, modelId: string, dialogs: SettingsDialogs, ctx: ExtensionCommandContext): Promise<unknown> {
		if (field.kind === "fallback") {
			return this.chooseFallback(dialogs, ctx);
		}
		if (field.kind === "boolean") {
			return choice === "true";
		}
		if (field.kind === "modalities") {
			return ProviderSettingsCommand.MODALITIES.get(choice);
		}
		const current = this.current(field, providerId, modelId, ctx);
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

	private static choices(field: EditableField): string[] {
		if (field.kind === "boolean") {
			return ["true", "false"];
		}
		if (field.kind === "modalities") {
			return [...ProviderSettingsCommand.MODALITIES.keys()];
		}
		if (field.kind === "fallback") {
			return [ProviderSettingsCommand.CHOOSE_FALLBACK];
		}
		return [ProviderSettingsCommand.EDIT_VALUE];
	}

	/** Only a chat model with credentials can serve the turn, so only its provider is offered. */
	private async chooseFallback(dialogs: SettingsDialogs, ctx: ExtensionCommandContext): Promise<ModelFallback | null> {
		const available = await ctx.modelRegistry.getAvailableOfType("chat");
		const providers = [...new Set(available.map((model) => model.provider))];
		if (providers.length === 0) {
			ctx.ui.notify("No provider with credentials has a chat model to fall back to", "warning");
			return null;
		}
		const entries = providers.map((id) => {
			const name = ctx.modelRegistry.getProviderDisplayName(id);
			return { item: { value: id, label: id, description: name }, search: `${id} ${name}` };
		});
		let cursor: string | undefined;
		for (;;) {
			const provider = await dialogs.pick("Fallback provider", entries, [], false, cursor);
			if (provider === undefined) {
				return null;
			}
			const model = await this.chooseModel(provider, dialogs, ctx);
			if (model !== undefined) {
				return { provider, model };
			}
			cursor = provider;
		}
	}

	/** The text `/model` searches, which pi keeps inside its own selector. */
	private static searchText(provider: string, id: string, name: string | undefined): string {
		return `${provider} ${provider}/${id} ${provider} ${id}${name === undefined ? "" : ` ${name}`}`;
	}

	/** What the field currently resolves to, for the row that shows it. */
	private display(field: EditableField, providerId: string, modelId: string, ctx: ExtensionCommandContext): string {
		const stored = ProviderSettingsCommand.at(this.override(providerId, modelId), field.path);
		const value = stored !== undefined ? stored : ProviderSettingsCommand.at(ctx.modelRegistry.getModelOfType("chat", providerId, modelId), field.path);
		if (value === undefined) {
			return ProviderSettingsCommand.UNSET;
		}
		if (field.kind === "fallback" && typeof value === "object" && value !== null) {
			const fallback = value as ModelFallback;
			return `${fallback.provider}/${fallback.model}`;
		}
		if (field.kind === "modalities" && Array.isArray(value)) {
			return value.join(", ");
		}
		if (field.kind === "text") {
			return String(value).replace(/\s+/g, " ");
		}
		return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
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

	private static parse(answer: string): unknown {
		try {
			return JSON.parse(answer);
		} catch {
			return undefined;
		}
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

	private override(providerId: string, modelId: string): ModelOverride {
		return { ...(this.store.all()[providerId]?.modelOverrides?.[modelId] ?? {}) };
	}

	private commit(providerId: string, modelId: string, next: ModelOverride, ctx: ExtensionCommandContext, message: string): void {
		if (this.save(providerId, modelId, next, ctx)) {
			ctx.ui.notify(`${message}; open /model to apply`, "info");
		}
	}

	/** An override left empty is dropped, and an empty override map leaves the provider file. */
	private save(providerId: string, modelId: string, next: ModelOverride, ctx: ExtensionCommandContext): boolean {
		const entry = this.store.all()[providerId];
		if (entry === undefined || !this.valid(modelId, next, ctx)) {
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
