/** The `/providers-settings` command: edit or clear per-model overrides for a registered provider. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { COMMAND_NAME_SETTINGS, type ModelOverride, type ModelOverrides, type ProviderEntry } from "./provider-config.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import { ProviderStore } from "./provider-store.ts";

interface EditableField {
	readonly label: string;
	readonly kind: "text" | "boolean" | "limit" | "cost";
	readonly field?: "name" | "reasoning" | "contextWindow" | "maxTokens";
	readonly costField?: "input" | "output" | "cacheRead" | "cacheWrite";
}

export class ProviderSettingsCommand {
	/** The fields the catalog itself supplies, in the order the README documents them. */
	private static readonly FIELDS: readonly EditableField[] = [
		{ label: "name", kind: "text", field: "name" },
		{ label: "reasoning", kind: "boolean", field: "reasoning" },
		{ label: "contextWindow", kind: "limit", field: "contextWindow" },
		{ label: "maxTokens", kind: "limit", field: "maxTokens" },
		{ label: "cost.input", kind: "cost", costField: "input" },
		{ label: "cost.output", kind: "cost", costField: "output" },
		{ label: "cost.cacheRead", kind: "cost", costField: "cacheRead" },
		{ label: "cost.cacheWrite", kind: "cost", costField: "cacheWrite" },
	];

	private static readonly EDIT = "Edit a field";
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
		const action = await ctx.ui.select(`${providerId} / ${modelId}`, [ProviderSettingsCommand.EDIT, ProviderSettingsCommand.CLEAR]);
		if (!action) {
			return;
		}
		if (action === ProviderSettingsCommand.CLEAR) {
			this.clear(providerId, providers[providerId], modelId, ctx);
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
			return (await ctx.ui.input("Model id"))?.trim() || undefined;
		}
		const labels = new Map(models.map((model) => [`${model.id} — ${model.name}`, model.id]));
		const choice = await ctx.ui.select("Model", [...labels.keys(), ProviderSettingsCommand.MANUAL]);
		if (choice === undefined || choice === ProviderSettingsCommand.MANUAL) {
			return (await ctx.ui.input("Model id"))?.trim() || undefined;
		}
		return labels.get(choice);
	}

	private async edit(providerId: string, entry: ProviderEntry, modelId: string, ctx: ExtensionCommandContext): Promise<void> {
		const choice = await ctx.ui.select("Field", ProviderSettingsCommand.FIELDS.map((field) => field.label));
		const field = ProviderSettingsCommand.FIELDS.find((candidate) => candidate.label === choice);
		if (!field) {
			return;
		}
		const value = await this.value(field, providerId, modelId, ctx);
		if (value === undefined) {
			ctx.ui.notify(`${field.label} expects ${ProviderSettingsCommand.expectation(field)}`, "warning");
			return;
		}
		this.save(providerId, entry, modelId, (override) => this.assign(override, field, value));
		ctx.ui.notify(`Saved ${field.label} for ${modelId}; open /model to apply`, "info");
	}

	private async value(field: EditableField, providerId: string, modelId: string, ctx: ExtensionCommandContext): Promise<unknown> {
		const current = this.current(field, providerId, modelId, ctx);
		if (field.kind === "boolean") {
			const choice = await ctx.ui.select(`${field.label} (current: ${current})`, ["true", "false"]);
			return choice === undefined ? undefined : choice === "true";
		}
		const answer = (await ctx.ui.input(`${field.label}${current === "" ? "" : ` (current: ${current})`}`))?.trim();
		if (answer === undefined || answer === "") {
			return undefined;
		}
		if (field.kind === "text") {
			return answer;
		}
		const number = Number(answer);
		if (field.kind === "limit") {
			return /^[1-9]\d*$/.test(answer) && Number.isSafeInteger(number) ? number : undefined;
		}
		return /^\d+(?:\.\d+)?$/.test(answer) && Number.isFinite(number) ? number : undefined;
	}

	/** The override value when one is set, else the registry's effective value. */
	private current(field: EditableField, providerId: string, modelId: string, ctx: ExtensionCommandContext): string {
		const override = this.store.all()[providerId]?.modelOverrides?.[modelId];
		if (field.costField !== undefined) {
			const own = override?.cost?.[field.costField];
			if (own !== undefined) {
				return String(own);
			}
		} else if (field.field !== undefined) {
			const own = override?.[field.field];
			if (own !== undefined) {
				return String(own);
			}
		}
		const model = ctx.modelRegistry.getModelOfType("chat", providerId, modelId);
		if (model === undefined) {
			return "";
		}
		if (field.costField !== undefined) {
			return String(model.cost?.[field.costField] ?? "");
		}
		if (field.field === undefined) {
			return "";
		}
		return String(model[field.field]);
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
		return "a non-empty string";
	}

	private clear(providerId: string, entry: ProviderEntry, modelId: string, ctx: ExtensionCommandContext): void {
		this.save(providerId, entry, modelId, () => ({}));
		ctx.ui.notify(`Cleared the override for ${modelId}; open /model to apply`, "info");
	}

	private assign(override: ModelOverride, field: EditableField, value: unknown): ModelOverride {
		if (field.costField !== undefined) {
			return { ...override, cost: { ...override.cost, [field.costField]: value as number } };
		}
		if (field.field !== undefined) {
			return { ...override, [field.field]: value } as ModelOverride;
		}
		return override;
	}

	/** An override left empty is dropped, and an empty override map leaves the provider file. */
	private save(providerId: string, entry: ProviderEntry, modelId: string, mutate: (override: ModelOverride) => ModelOverride): void {
		const overrides: ModelOverrides = { ...(entry.modelOverrides ?? {}) };
		const next = mutate({ ...(overrides[modelId] ?? {}) });
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
		this.store.add(providerId, updated);
		this.registry.replace(providerId, updated);
	}
}
