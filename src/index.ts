/**
 * pi-custom-login — extension entry point.
 *
 * Composition only: the stored providers are registered with pi and the
 * `/providers` command is attached. Model lists are not read here; pi calls
 * each provider's `refreshModels` when it loads a catalog.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ProviderCommand } from "./provider-command.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import { ProviderStore } from "./provider-store.ts";

export class CustomLoginExtension {
	register(pi: ExtensionAPI): void {
		const store = new ProviderStore(ProviderStore.agentDir());
		const registry = new ProviderRegistry(pi);
		registry.registerAll(store.all());
		new ProviderCommand(pi, store, registry).register();
	}
}

export default function (pi: ExtensionAPI): void {
	new CustomLoginExtension().register(pi);
}
