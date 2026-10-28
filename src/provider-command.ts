/** The `/providers` command: add, remove, list, and configure providers. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { COMMAND_NAME, type ProviderEntry } from "./provider-config.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import { ProviderSettings } from "./provider-settings.ts";
import { ProviderStore } from "./provider-store.ts";

export class ProviderCommand {
	private readonly pi: ExtensionAPI;
	private readonly store: ProviderStore;
	private readonly registry: ProviderRegistry;

	constructor(pi: ExtensionAPI, store: ProviderStore, registry: ProviderRegistry) {
		this.pi = pi;
		this.store = store;
		this.registry = registry;
	}

	register(): void {
		this.pi.registerCommand(COMMAND_NAME, {
			description: "Add, remove, list, or configure custom model providers",
			handler: (args, ctx) => this.run(args, ctx),
		});
	}

	private async run(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const [action, id, baseUrl, ...extra] = args.trim().split(/\s+/).filter(Boolean);
		if (action === "add") {
			await this.add(id, baseUrl, extra, ctx);
			return;
		}
		if (action === "remove") {
			this.remove(id, ctx);
			return;
		}
		if (action === "list") {
			this.list(ctx);
			return;
		}
		if (action === "settings" || action === undefined) {
			await this.settings(id, ctx);
			return;
		}
		ctx.ui.notify(`Usage: /${COMMAND_NAME} [settings [id]] | add <id> <baseUrl> | remove <id> | list`, "warning");
	}

	private async add(id: string | undefined, baseUrl: string | undefined, extra: string[], ctx: ExtensionCommandContext): Promise<void> {
		if (extra.length > 0) {
			ctx.ui.notify(`Keys are stored by /login <id>, not by /${COMMAND_NAME} add`, "warning");
			return;
		}
		const providerId = id ?? (await ctx.ui.input("Provider ID"));
		const url = baseUrl ?? (await ctx.ui.input("Base URL", "https://example.com/v1"));
		if (!providerId || !url) {
			ctx.ui.notify(`Usage: /${COMMAND_NAME} add <id> <baseUrl>`, "warning");
			return;
		}
		const existing = this.store.all()[providerId];
		const entry: ProviderEntry = { ...existing, baseUrl: url };
		this.store.add(providerId, entry);
		this.registry.replace(providerId, entry);
		ctx.ui.notify(`Added ${providerId}; run /login ${providerId} for its key, then /model`, "info");
	}

	private remove(id: string | undefined, ctx: ExtensionCommandContext): void {
		if (!id) {
			ctx.ui.notify(`Usage: /${COMMAND_NAME} remove <id>`, "warning");
			return;
		}
		this.store.remove(id);
		this.registry.remove(id);
		ctx.ui.notify(`Removed ${id}`, "info");
	}

	private list(ctx: ExtensionCommandContext): void {
		const lines = Object.entries(this.store.all()).map(([id, entry]) => {
			const fallback = entry.fallback ? ` -> ${entry.fallback.model.provider}/${entry.fallback.model.id}` : "";
			return `${id} ${entry.baseUrl}${fallback}`;
		});
		ctx.ui.notify(lines.length === 0 ? "No custom providers" : lines.join("\n"), "info");
	}

	/** Picks a provider, refreshes the catalog, edits a detached draft, saves on commit. */
	private async settings(id: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		const providerId = id ?? await this.pickProvider(ctx);
		if (!providerId) {
			return;
		}
		const stored = this.store.all()[providerId];
		if (!stored) {
			ctx.ui.notify(`${providerId} is not a registered provider`, "warning");
			return;
		}
		await ctx.modelRegistry.refresh();
		const picked = await ProviderSettings.pick(providerId, stored.fallback, this.registry.catalog(), ctx);
		if (picked === undefined) {
			ctx.ui.notify("Settings unchanged", "info");
			return;
		}
		const entry: ProviderEntry = {
			...stored,
			...(picked === null ? {} : { fallback: picked }),
		};
		if (picked === null) {
			delete entry.fallback;
		}
		this.store.add(providerId, entry);
		this.registry.replace(providerId, entry);
		ctx.ui.notify(
			picked === null
				? `${providerId}: fallback disabled`
				: `${providerId}: fails over to ${picked.model.provider}/${picked.model.id} after ${picked.timeoutMs} ms`,
			"info",
		);
	}

	private async pickProvider(ctx: ExtensionCommandContext): Promise<string | undefined> {
		const ids = Object.keys(this.store.all());
		if (ids.length === 0) {
			ctx.ui.notify("No custom providers; add one with /providers add <id> <baseUrl>", "warning");
			return undefined;
		}
		return ctx.ui.select("Configure which provider?", ids);
	}
}
