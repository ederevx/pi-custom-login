import { FakeCommandContext, FakePi, assertEq, scratchDir, test } from "./harness.ts";
import { ProviderRegistry } from "../src/provider-registry.ts";
import { ProviderSettingsCommand } from "../src/provider-settings-command.ts";
import { ProviderStore } from "../src/provider-store.ts";

const VERBOO = "verboo https://code.verboo.ai/router/v1";
const GLM = "glm-5.2 — GLM 5.2";
const EDIT = "Edit a field";
const CLEAR_FIELD = "Clear a field";
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

test("cancelling at a value prompt notifies nothing", async () => {
	const { pi, store } = registered("settings-cancel-value");
	const ctx = new FakeCommandContext([undefined], [VERBOO, GLM, EDIT, "contextWindow"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(ctx.notifications), "[]");
	assertEq(store.all().verboo.modelOverrides, undefined);
});

test("cancelling at the model list opens no prompt and records nothing", async () => {
	const { pi, store } = registered("settings-cancel-model");
	const ctx = new FakeCommandContext(["unused"], [VERBOO, undefined], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(ctx.notifications), "[]");
	assertEq(store.all().verboo.modelOverrides, undefined);
});

test("the field list follows pi's documented order", async () => {
	const { pi } = registered("settings-fields");
	const ctx = new FakeCommandContext([], [VERBOO, GLM, EDIT], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(ctx.offers.at(-1)), JSON.stringify([
		"name",
		"reasoning",
		"thinkingLevelMap",
		"input",
		"inputLimits",
		"cost.input",
		"cost.output",
		"cost.cacheRead",
		"cost.cacheWrite",
		"cost.tiers",
		"promptCache",
		"contextWindow",
		"maxTokens",
		"samplingParams",
		"samplingParamsByThinkingLevel",
		"headers",
		"compat",
	]));
});

test("a JSON field saves the parsed object", async () => {
	const { pi, store } = registered("settings-json");
	const ctx = new FakeCommandContext(['{"X-Tier":"fast"}'], [VERBOO, GLM, EDIT, "headers"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(store.all().verboo.modelOverrides?.["glm-5.2"]?.headers), JSON.stringify({ "X-Tier": "fast" }));
});

test("invalid JSON warns and records nothing", async () => {
	const { pi, store } = registered("settings-json-invalid");
	const ctx = new FakeCommandContext(["{oops"], [VERBOO, GLM, EDIT, "headers"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
	assertEq(ctx.lastMessage, "headers expects valid JSON");
});

test("JSON in the wrong shape is refused by the catalog's rules", async () => {
	const { pi, store } = registered("settings-json-shape");
	const ctx = new FakeCommandContext(['{"X-Tier":1}'], [VERBOO, GLM, EDIT, "headers"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
	assertEq(ctx.notifications.at(-1)?.type, "warning");
	assertEq(ctx.lastMessage.includes("headers.X-Tier"), true);
});

test("the modality select saves the pi modalities", async () => {
	const { pi, store } = registered("settings-input");
	const ctx = new FakeCommandContext([], [VERBOO, GLM, EDIT, "input", "text, image"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(store.all().verboo.modelOverrides?.["glm-5.2"]?.input), JSON.stringify(["text", "image"]));
});

test("clearing one field keeps the rest of the override", async () => {
	const { pi, store } = registered("settings-clear-field", {
		baseUrl: "https://code.verboo.ai/router/v1",
		modelOverrides: { "glm-5.2": { contextWindow: 262144, cost: { input: 5, output: 6 } } },
	});
	const ctx = new FakeCommandContext([], [VERBOO, GLM, CLEAR_FIELD, "cost.input"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	const override = store.all().verboo.modelOverrides?.["glm-5.2"];
	assertEq(override?.contextWindow, 262144);
	assertEq(JSON.stringify(override?.cost), JSON.stringify({ output: 6 }));
	assertEq(ctx.lastMessage, "Cleared cost.input for glm-5.2; open /model to apply");
});

test("clearing the last field drops the override", async () => {
	const { pi, store } = registered("settings-clear-last", {
		baseUrl: "https://code.verboo.ai/router/v1",
		modelOverrides: { "glm-5.2": { contextWindow: 262144 } },
	});
	const ctx = new FakeCommandContext([], [VERBOO, GLM, CLEAR_FIELD, "contextWindow"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
});

test("a JSON prompt shows the registry's effective value", async () => {
	const { pi } = registered("settings-current");
	const model = { ...GLM_MODEL, compat: { supportsDeveloperRole: false } };
	const ctx = new FakeCommandContext([undefined], [VERBOO, GLM, EDIT, "compat"], { verboo: [model] });
	await pi.command("providers-settings", "", ctx);
	assertEq(ctx.prompts.at(-1), 'compat (current: {"supportsDeveloperRole":false})');
});
