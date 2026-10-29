import { FakeCommandContext, FakePi, assertEq, scratchDir, test } from "./harness.ts";
import { ProviderCommand } from "../src/provider-command.ts";
import { ProviderRegistry } from "../src/provider-registry.ts";
import { ProviderStore } from "../src/provider-store.ts";

function subject(name: string): { pi: FakePi; store: ProviderStore } {
	const pi = new FakePi();
	const store = new ProviderStore(`${scratchDir()}/${name}`);
	new ProviderCommand(pi.extension(), store, new ProviderRegistry(pi.extension())).register();
	return { pi, store };
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
