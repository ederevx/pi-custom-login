import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ProviderCommand } from "./provider-command.ts";
import { ProviderRegistry } from "./provider-registry.ts";
import { ProviderStore } from "./provider-store.ts";

export class CustomLoginExtension {
	register(pi: ExtensionAPI): void {
		const store = new ProviderStore(ProviderStore.agentDir());
		const registry = new ProviderRegistry(pi);
		registry.attachStore(store);
		registry.registerAll(store.all());
		new ProviderCommand(pi, store, registry).register();
		pi.on("session_start", (_event, ctx) => {
			registry.bindSession(ctx.modelRegistry);
		});
	}
}

export default function (pi: ExtensionAPI): void {
	new CustomLoginExtension().register(pi);
}
