import { FakeCommandContext, FakePi, assertEq, scratchDir, test } from "./harness.ts";
import { ProviderCommand } from "../src/provider-command.ts";
import { ProviderRegistry } from "../src/provider-registry.ts";
import { ProviderStore } from "../src/provider-store.ts";

function subject(name: string): { pi: FakePi; store: ProviderStore; registry: ProviderRegistry } {
	const pi = new FakePi();
	const store = new ProviderStore(`${scratchDir()}/${name}`);
	const registry = new ProviderRegistry(pi.extension());
	new ProviderCommand(pi.extension(), store, registry).register();
	return { pi, store, registry };
}

test("add registers the provider immediately and records it", async () => {
	const { pi, store } = subject("command-add");
	const ctx = new FakeCommandContext();
	await pi.command("providers", "add verboo https://code.verboo.ai/router/v1", ctx);
	assertEq(pi.providers.get("verboo")?.baseUrl, "https://code.verboo.ai/router/v1");
	assertEq(pi.providers.get("verboo")?.api, "openai-completions");
	assertEq(pi.providers.get("verboo")?.authHeader, true);
	assertEq(JSON.stringify(pi.providers.get("verboo")?.models), "[]");
	assertEq(store.all().verboo.baseUrl, "https://code.verboo.ai/router/v1");
	assertEq(ctx.lastMessage, "Added verboo; run /login verboo for its key, then /model");
});

test("add asks for what the arguments left out", async () => {
	const { pi } = subject("command-prompt");
	const ctx = new FakeCommandContext(["asked", "https://asked.example/v1"]);
	await pi.command("providers", "add", ctx);
	assertEq(pi.providers.has("asked"), true);
	assertEq(pi.providers.get("asked")?.baseUrl, "https://asked.example/v1");
});

test("add refuses a registration without a URL", async () => {
	const { pi } = subject("command-no-url");
	const ctx = new FakeCommandContext([undefined, undefined]);
	await pi.command("providers", "add", ctx);
	assertEq(pi.providers.size, 0);
	assertEq(ctx.notifications.at(-1)?.type, "warning");
});

test("add refuses a key argument and records nothing", async () => {
	const { pi, store } = subject("command-key-argument");
	const ctx = new FakeCommandContext();
	await pi.command("providers", "add proxy https://proxy.example/v1 sk-live-abc", ctx);
	assertEq(pi.providers.size, 0);
	assertEq(Object.keys(store.all()).length, 0);
	assertEq(ctx.notifications.at(-1)?.type, "warning");
	assertEq(ctx.lastMessage, "Keys are stored by /login <id>, not by /providers add");
});

test("re-adding an id replaces its registration", async () => {
	const { pi } = subject("command-replace");
	await pi.command("providers", "add verboo https://old.example/v1", new FakeCommandContext());
	await pi.command("providers", "add verboo https://code.verboo.ai/router/v1", new FakeCommandContext());
	assertEq(pi.unregistered.at(-1), "verboo");
	assertEq(pi.providers.get("verboo")?.baseUrl, "https://code.verboo.ai/router/v1");
});

test("remove unregisters and forgets the provider", async () => {
	const { pi, store } = subject("command-remove");
	await pi.command("providers", "add first https://first.example/v1", new FakeCommandContext());
	await pi.command("providers", "remove first", new FakeCommandContext());
	assertEq(pi.unregistered.at(-1), "first");
	assertEq(pi.providers.has("first"), false);
	assertEq(Object.keys(store.all()).length, 0);
});

test("remove without an id only explains itself", async () => {
	const { pi } = subject("command-remove-usage");
	const ctx = new FakeCommandContext();
	await pi.command("providers", "remove", ctx);
	assertEq(ctx.notifications.at(-1)?.type, "warning");
	assertEq(ctx.lastMessage.startsWith("Usage:"), true);
});

test("list reports the stored providers and an empty store", async () => {
	const { pi } = subject("command-list");
	const empty = new FakeCommandContext();
	await pi.command("providers", "list", empty);
	assertEq(empty.lastMessage, "No custom providers");
	await pi.command("providers", "add first https://first.example/v1", new FakeCommandContext());
	const filled = new FakeCommandContext();
	await pi.command("providers", "list", filled);
	assertEq(filled.lastMessage, "first https://first.example/v1");
});

test("an unknown action prints the usage", async () => {
	const { pi } = subject("command-unknown");
	const ctx = new FakeCommandContext();
	await pi.command("providers", "edit first", ctx);
	assertEq(ctx.notifications.at(-1)?.type, "warning");
	assertEq(ctx.lastMessage.includes("add <id> <baseUrl>"), true);
});

/** A TUI context that opens the fallback screen and drives it with `keys`. */
function settingsContext(keys: string[], catalog: Array<{ provider: string; id: string; api: string; contextWindow: number; input: string[] }>) {
	const ctx = new FakeCommandContext() as unknown as {
		mode: string;
		ui: Record<string, unknown>;
		notifications: Array<{ message: string }>;
		lastMessage: string;
	};
	let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
	const theme = { fg: (_key: string, text: string) => text };
	const keybindings = {
		matches: (data: string, id: string): boolean =>
			({ "tui.select.up": ["\u001b[A"], "tui.select.down": ["\u001b[B"], "tui.select.confirm": ["\r"], "tui.select.cancel": ["\u001b"] } as Record<string, string[]>)[id]?.includes(data) ?? false,
	};
	ctx.mode = "tui";
	ctx.ui = {
		notify: (message: string) => {
			(ctx.notifications as Array<{ message: string }>).push({ message });
		},
		select: async () => "verboo",
		custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value?: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => {
			await new Promise<void>((resolve) => {
				component = factory({ requestRender: () => {} }, theme, keybindings, () => resolve());
				setImmediate(() => {
					for (const key of keys) {
						component!.handleInput(key);
					}
					resolve();
				});
			});
		},
	};
	ctx.modelRegistry = { refresh: async () => {}, getAll: () => catalog };
	return {
		ctx: ctx as unknown as Parameters<FakePi["command"]>[2],
		component: () => component!,
		lastNotice: () => (ctx.notifications as Array<{ message: string }>).at(-1)?.message ?? "",
	};
}

test("settings saves each change to the store and re-registers the provider", async () => {
	const { pi, store, registry } = subject("command-settings");
	const catalog = [
		{ provider: "verboo", id: "big", api: "openai-completions", contextWindow: 1000, input: ["text"] },
		{ provider: "other", id: "fits", api: "openai-completions", contextWindow: 1000, input: ["text"] },
	];
	registry.bindSession({ getAll: () => catalog } as never);
	await pi.command("providers", "add verboo https://code.verboo.ai/router/v1", new FakeCommandContext());
	// Open the fallback row, move past Disabled, choose other/fits, then close.
	const { ctx } = settingsContext(["\r", "\u001b[B", "\r", "\u001b"], catalog);
	await pi.command("providers", "settings verboo", ctx);
	assertEq(JSON.stringify(store.all().verboo?.fallback), '{"model":{"provider":"other","id":"fits"},"timeoutMs":30000}');
	assertEq(pi.providers.get("verboo")?.baseUrl, "https://code.verboo.ai/router/v1");
});

test("choosing Disabled in settings removes the stored fallback", async () => {
	const { pi, store, registry } = subject("command-settings-disabled");
	const catalog = [
		{ provider: "verboo", id: "big", api: "openai-completions", contextWindow: 1000, input: ["text"] },
		{ provider: "other", id: "fits", api: "openai-completions", contextWindow: 1000, input: ["text"] },
	];
	registry.bindSession({ getAll: () => catalog } as never);
	await pi.command("providers", "add verboo https://code.verboo.ai/router/v1", new FakeCommandContext());
	await pi.command("providers", "settings verboo", settingsContext(["\r", "\u001b[B", "\r", "\u001b"], catalog).ctx);
	assertEq(store.all().verboo?.fallback?.model.id, "fits");
	// Reopen: the current model is preselected, so the first entry is Disabled.
	await pi.command("providers", "settings verboo", settingsContext(["\r", "\u001b[A", "\r", "\u001b"], catalog).ctx);
	assertEq(store.all().verboo?.fallback, undefined);
	assertEq(store.all().verboo?.baseUrl, "https://code.verboo.ai/router/v1");
});

test("a provider removed while the screen is open is not written back", async () => {
	const { pi, store, registry } = subject("command-settings-removed");
	const catalog = [{ provider: "other", id: "fits", api: "openai-completions", contextWindow: 1000, input: ["text"] }];
	registry.bindSession({ getAll: () => catalog } as never);
	await pi.command("providers", "add verboo https://code.verboo.ai/router/v1", new FakeCommandContext());
	const screen = settingsContext([], catalog);
	const opened = pi.command("providers", "settings verboo", screen.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	store.remove("verboo");
	screen.component().handleInput("\r");
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\r");
	screen.component().handleInput("\u001b");
	await opened;
	assertEq(store.all().verboo, undefined);
	assertEq(screen.lastNotice().includes("was removed; settings not saved"), true);
});

test("the timeout row is not stored while the fallback is disabled", async () => {
	const { pi, store, registry } = subject("command-settings-timeout-disabled");
	registry.bindSession({ getAll: () => [] } as never);
	await pi.command("providers", "add verboo https://code.verboo.ai/router/v1", new FakeCommandContext());
	const screen = settingsContext([], []);
	const opened = pi.command("providers", "settings verboo", screen.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	screen.component().handleInput("\u0001");
	screen.component().handleInput("\u000b");
	for (const digit of "450") screen.component().handleInput(digit);
	screen.component().handleInput("\r");
	screen.component().handleInput("\u001b");
	await opened;
	assertEq(store.all().verboo?.fallback, undefined);
});
