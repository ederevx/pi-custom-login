import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ModelFailover } from "./model-failover.ts";
import { ProviderCommand } from "./provider-command.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import { ProviderSettingsCommand } from "./provider-settings-command.ts";
import { ProviderStore } from "./provider-store.ts";

export class CustomLoginExtension {
	register(pi: ExtensionAPI): void {
		const store = new ProviderStore(ProviderStore.agentDir());
		const failover = new ModelFailover(pi, store);
		const registry = new ProviderRegistry(pi, failover);
		registry.registerAll(store.all());
		new ProviderCommand(pi, store, registry).register();
		new ProviderSettingsCommand(pi, store, registry).register();
	}
}

export default function (pi: ExtensionAPI): void {
	new CustomLoginExtension().register(pi);
}
