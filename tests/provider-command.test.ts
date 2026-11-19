import { FakeCommandContext, FakePi, assertEq, scratchDir, test } from "./harness.ts";
import { ProviderCommand } from "../src/provider-command.ts";
import { ModelFailover } from "../src/model-failover.ts";
import { ProviderRegistry } from "../src/provider-registry.ts";
import { ProviderStore } from "../src/provider-store.ts";

function subject(name: string): { pi: FakePi; store: ProviderStore } {
	const pi = new FakePi();
	const store = new ProviderStore(`${scratchDir()}/${name}`);
	new ProviderCommand(pi.extension(), store, new ProviderRegistry(pi.extension(), new ModelFailover(pi.extension(), store))).register();
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

test("add refuses a registration it cannot complete", async () => {
	const cases: Array<[string, string, string, Array<string | undefined>, string?]> = [
		["command-no-url", "a missing URL", "add", [undefined, undefined]],
		["command-key-argument", "a key argument", "add proxy https://proxy.example/v1 sk-live-abc", [], "Keys are stored by /login <id>, not by /providers add"],
	];
	for (const [slug, label, args, answers, message] of cases) {
		const { pi, store } = subject(slug);
		const ctx = new FakeCommandContext(answers);
		await pi.command("providers", args, ctx);
		assertEq(pi.providers.size, 0, label);
		assertEq(Object.keys(store.all()).length, 0, label);
		assertEq(ctx.notifications.at(-1)?.type, "warning", label);
		if (message !== undefined) assertEq(ctx.lastMessage, message, label);
	}
});

test("re-adding an id replaces its registration and keeps its model overrides", async () => {
	const { pi, store } = subject("command-replace");
	store.add("verboo", {
		baseUrl: "https://old.example/v1",
		modelOverrides: { "glm-5.2": { contextWindow: 262144 } },
	});
	await pi.command("providers", "add verboo https://code.verboo.ai/router/v1", new FakeCommandContext());
	assertEq(pi.unregistered.at(-1), "verboo");
	assertEq(pi.providers.get("verboo")?.baseUrl, "https://code.verboo.ai/router/v1");
	assertEq(store.all().verboo.baseUrl, "https://code.verboo.ai/router/v1");
	assertEq(store.all().verboo.modelOverrides?.["glm-5.2"]?.contextWindow, 262144);
});

test("remove unregisters and forgets the provider", async () => {
	const { pi, store } = subject("command-remove");
	await pi.command("providers", "add first https://first.example/v1", new FakeCommandContext());
	await pi.command("providers", "remove first", new FakeCommandContext());
	assertEq(pi.unregistered.at(-1), "first");
	assertEq(pi.providers.has("first"), false);
	assertEq(Object.keys(store.all()).length, 0);
});

test("a removal without an id and an unknown action print the usage", async () => {
	const cases: Array<[string, string, string, string]> = [
		["command-remove-usage", "a removal without an id", "remove", "Usage:"],
		["command-unknown", "an unknown action", "edit first", "add <id> <baseUrl>"],
	];
	for (const [slug, label, args, usage] of cases) {
		const { pi } = subject(slug);
		const ctx = new FakeCommandContext();
		await pi.command("providers", args, ctx);
		assertEq(ctx.notifications.at(-1)?.type, "warning", label);
		assertEq(ctx.lastMessage.includes(usage), true, label);
	}
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
