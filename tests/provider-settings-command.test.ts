import { FakeCommandContext, FakePi, assertEq, scratchDir, test } from "./harness.ts";
import { ProviderRegistry } from "../src/provider-registry.ts";
import { ProviderSettingsCommand } from "../src/provider-settings-command.ts";
import { ProviderStore } from "../src/provider-store.ts";

const VERBOO = "verboo https://code.verboo.ai/router/v1";
const GLM = "glm-5.2 — GLM 5.2";
const EDIT = "Edit a field";
const CLEAR = "Clear this model's override";

const GLM_MODEL = {
	id: "glm-5.2",
	name: "GLM 5.2",
	reasoning: true,
	contextWindow: 1000000,
	maxTokens: 32768,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

function subject(name: string): { pi: FakePi; store: ProviderStore } {
	const pi = new FakePi();
	const store = new ProviderStore(`${scratchDir()}/${name}`);
	new ProviderSettingsCommand(pi.extension(), store, new ProviderRegistry(pi.extension())).register();
	return { pi, store };
}

function registered(name: string, entry = { baseUrl: "https://code.verboo.ai/router/v1" }): { pi: FakePi; store: ProviderStore } {
	const pair = subject(name);
	pair.store.add("verboo", entry);
	return pair;
}

test("a store without providers explains itself", async () => {
	const { pi } = subject("settings-empty");
	const ctx = new FakeCommandContext();
	await pi.command("providers-settings", "", ctx);
	assertEq(ctx.lastMessage, "No custom providers; add one with /providers add");
	assertEq(ctx.notifications.at(-1)?.type, "warning");
});

test("editing a limit writes the override and re-registers the provider", async () => {
	const { pi, store } = registered("settings-edit");
	const ctx = new FakeCommandContext(["262144"], [VERBOO, GLM, EDIT, "contextWindow"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides?.["glm-5.2"]?.contextWindow, 262144);
	assertEq(store.all().verboo.baseUrl, "https://code.verboo.ai/router/v1");
	assertEq(pi.unregistered.at(-1), "verboo");
	assertEq(ctx.lastMessage, "Saved contextWindow for glm-5.2; open /model to apply");
});

test("editing a cost field merges over the other prices", async () => {
	const { pi, store } = registered("settings-cost");
	const ctx = new FakeCommandContext(["5"], [VERBOO, GLM, EDIT, "cost.input"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(store.all().verboo.modelOverrides?.["glm-5.2"]?.cost), JSON.stringify({ input: 5 }));
});

test("editing reasoning offers true and false", async () => {
	const { pi, store } = registered("settings-reasoning");
	const ctx = new FakeCommandContext([], [VERBOO, GLM, EDIT, "reasoning", "false"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides?.["glm-5.2"]?.reasoning, false);
});

test("an invalid value warns and records nothing", async () => {
	const { pi, store } = registered("settings-invalid");
	const ctx = new FakeCommandContext(["abc"], [VERBOO, GLM, EDIT, "contextWindow"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
	assertEq(ctx.notifications.at(-1)?.type, "warning");
});

test("clearing drops the override and an empty map leaves the entry", async () => {
	const { pi, store } = registered("settings-clear", {
		baseUrl: "https://code.verboo.ai/router/v1",
		modelOverrides: { "glm-5.2": { contextWindow: 262144 } },
	});
	const ctx = new FakeCommandContext([], [VERBOO, GLM, CLEAR], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
	assertEq(store.all().verboo.baseUrl, "https://code.verboo.ai/router/v1");
	assertEq(ctx.lastMessage, "Cleared the override for glm-5.2; open /model to apply");
});

test("an unfetched catalog falls back to typing the model id", async () => {
	const { pi, store } = registered("settings-manual");
	const ctx = new FakeCommandContext(["m2", "4096"], [VERBOO, EDIT, "maxTokens"], {});
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides?.m2?.maxTokens, 4096);
});

test("cancelling at the provider select records nothing", async () => {
	const { pi, store } = registered("settings-cancel");
	const ctx = new FakeCommandContext([], [undefined], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
	assertEq(pi.unregistered.length, 0);
});
