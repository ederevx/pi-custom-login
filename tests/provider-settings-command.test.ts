import { FakeCommandContext, FakePi, assertEq, scratchDir, test } from "./harness.ts";
import { ModelFailover } from "../src/model-failover.ts";
import { ProviderRegistry } from "../src/provider-registry.ts";
import { ProviderSettingsCommand } from "../src/provider-settings-command.ts";
import { ProviderStore } from "../src/provider-store.ts";

const VERBOO = "verboo — https://code.verboo.ai/router/v1";
const GLM = "glm-5.2 — GLM 5.2";
const EDIT = "Edit value";
const CLEAR_FIELD = "Clear override";
const CLEAR = "Clear this model's override";
const OVERRIDE = "override";
/** The fallback lists label a provider by its display name, which the fake returns as its id. */
const FALLBACK_VERBOO = "verboo — verboo";
const FALLBACK_OTHER = "other — other";

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
	new ProviderSettingsCommand(pi.extension(), store, new ProviderRegistry(pi.extension(), new ModelFailover(pi.extension(), store))).register();
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
	const ctx = new FakeCommandContext(["262144"], [VERBOO, GLM, "contextWindow", EDIT], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides?.["glm-5.2"]?.contextWindow, 262144);
	assertEq(store.all().verboo.baseUrl, "https://code.verboo.ai/router/v1");
	assertEq(pi.unregistered.at(-1), "verboo");
	assertEq(ctx.lastMessage, "Saved contextWindow for glm-5.2; open /model to apply");
});

test("editing a cost field merges over the other prices", async () => {
	const { pi, store } = registered("settings-cost");
	const ctx = new FakeCommandContext(["5"], [VERBOO, GLM, "cost.input", EDIT], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(store.all().verboo.modelOverrides?.["glm-5.2"]?.cost), JSON.stringify({ input: 5 }));
});

test("editing reasoning offers true and false", async () => {
	const { pi, store } = registered("settings-reasoning");
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "reasoning", "false"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides?.["glm-5.2"]?.reasoning, false);
});

test("an invalid value warns and records nothing", async () => {
	const { pi, store } = registered("settings-invalid");
	const ctx = new FakeCommandContext(["abc"], [VERBOO, GLM, "contextWindow", EDIT], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
	assertEq(ctx.notifications.at(-1)?.type, "warning");
});

test("clearing drops the override and an empty map leaves the entry", async () => {
	const { pi, store } = registered("settings-clear", {
		baseUrl: "https://code.verboo.ai/router/v1",
		modelOverrides: { "glm-5.2": { contextWindow: 262144 } },
	});
	const ctx = new FakeCommandContext([], [VERBOO, GLM, OVERRIDE, CLEAR], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
	assertEq(store.all().verboo.baseUrl, "https://code.verboo.ai/router/v1");
	assertEq(ctx.lastMessage, "Cleared the override for glm-5.2; open /model to apply");
});

test("an unfetched catalog falls back to typing the model id", async () => {
	const { pi, store } = registered("settings-manual");
	const ctx = new FakeCommandContext(["m2", "4096"], [VERBOO, "maxTokens", EDIT], {});
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

test("cancelling at a value prompt notifies nothing and reopens the fields", async () => {
	const { pi, store } = registered("settings-cancel-value");
	const ctx = new FakeCommandContext([undefined], [VERBOO, GLM, "contextWindow", EDIT], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(ctx.notifications), "[]");
	assertEq(store.all().verboo.modelOverrides, undefined);
	assertEq(JSON.stringify(ctx.offers[4]), JSON.stringify(ctx.offers[2]));
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
	const ctx = new FakeCommandContext([], [VERBOO, GLM], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(ctx.offers[2]), JSON.stringify([
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
		"fallback",
		OVERRIDE,
	]));
});

test("escape on the fields goes back to the models, then to the providers", async () => {
	const { pi } = registered("settings-back");
	const ctx = new FakeCommandContext([], [VERBOO, GLM, undefined, undefined, undefined], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(ctx.offers[3]), JSON.stringify(ctx.offers[1]));
	assertEq(JSON.stringify(ctx.offers[4]), JSON.stringify(ctx.offers[0]));
	assertEq(ctx.offers.length, 5);
});

test("escape on a field's choices reopens the fields", async () => {
	const { pi, store } = registered("settings-back-choices");
	const ctx = new FakeCommandContext(["4096"], [VERBOO, GLM, "contextWindow", undefined, "maxTokens", EDIT], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(ctx.offers[4]), JSON.stringify(ctx.offers[2]));
	assertEq(store.all().verboo.modelOverrides?.["glm-5.2"]?.maxTokens, 4096);
});

test("two edits in one run keep both", async () => {
	const { pi, store } = registered("settings-two-edits");
	const ctx = new FakeCommandContext(["262144", "32768"], [VERBOO, GLM, "contextWindow", EDIT, "maxTokens", EDIT], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	const override = store.all().verboo.modelOverrides?.["glm-5.2"];
	assertEq(override?.contextWindow, 262144);
	assertEq(override?.maxTokens, 32768);
});

test("a field without an override offers no clear", async () => {
	const { pi } = registered("settings-no-clear");
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "cost.input", undefined], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(ctx.offers[3]), JSON.stringify([EDIT]));
});

test("a field with an override offers clear beside the edit", async () => {
	const { pi } = registered("settings-clear-offer", {
		baseUrl: "https://code.verboo.ai/router/v1",
		modelOverrides: { "glm-5.2": { contextWindow: 262144 } },
	});
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "contextWindow", undefined], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(ctx.offers[3]), JSON.stringify([EDIT, CLEAR_FIELD]));
});

test("the choices title carries the current value", async () => {
	const { pi } = registered("settings-titles");
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "thinkingLevelMap", undefined, "contextWindow", undefined], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(ctx.titles.includes("thinkingLevelMap (current: not set)"), true);
	assertEq(ctx.titles.includes("contextWindow (current: 1000000)"), true);
	assertEq(ctx.titles.includes("verboo / glm-5.2"), true);
});

test("a JSON field saves the parsed object", async () => {
	const { pi, store } = registered("settings-json");
	const ctx = new FakeCommandContext(['{"X-Tier":"fast"}'], [VERBOO, GLM, "headers", EDIT], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(store.all().verboo.modelOverrides?.["glm-5.2"]?.headers), JSON.stringify({ "X-Tier": "fast" }));
});

test("invalid JSON warns and records nothing", async () => {
	const { pi, store } = registered("settings-json-invalid");
	const ctx = new FakeCommandContext(["{oops"], [VERBOO, GLM, "headers", EDIT], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
	assertEq(ctx.lastMessage, "headers expects valid JSON");
});

test("JSON in the wrong shape is refused by the catalog's rules", async () => {
	const { pi, store } = registered("settings-json-shape");
	const ctx = new FakeCommandContext(['{"X-Tier":1}'], [VERBOO, GLM, "headers", EDIT], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
	assertEq(ctx.notifications.at(-1)?.type, "warning");
	assertEq(ctx.lastMessage.includes("headers.X-Tier"), true);
});

test("the modality select saves the pi modalities", async () => {
	const { pi, store } = registered("settings-input");
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "input", "text, image"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(store.all().verboo.modelOverrides?.["glm-5.2"]?.input), JSON.stringify(["text", "image"]));
});

test("clearing one field keeps the rest of the override", async () => {
	const { pi, store } = registered("settings-clear-field", {
		baseUrl: "https://code.verboo.ai/router/v1",
		modelOverrides: { "glm-5.2": { contextWindow: 262144, cost: { input: 5, output: 6 } } },
	});
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "cost.input", CLEAR_FIELD], { verboo: [GLM_MODEL] });
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
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "contextWindow", CLEAR_FIELD], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
});

test("a price tier prompt shows the tiers as JSON, not as objects", async () => {
	const { pi } = registered("settings-tiers");
	const tier = { inputTokensAbove: 200000, input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
	const model = { ...GLM_MODEL, cost: { ...GLM_MODEL.cost, tiers: [tier] } };
	const ctx = new FakeCommandContext([undefined], [VERBOO, GLM, "cost.tiers", EDIT], { verboo: [model] });
	await pi.command("providers-settings", "", ctx);
	assertEq(ctx.prompts.at(-1), `cost.tiers (current: ${JSON.stringify([tier])})`);
});

test("a JSON prompt shows the registry's effective value", async () => {
	const { pi } = registered("settings-current");
	const model = { ...GLM_MODEL, compat: { supportsDeveloperRole: false } };
	const ctx = new FakeCommandContext([undefined], [VERBOO, GLM, "compat", EDIT], { verboo: [model] });
	await pi.command("providers-settings", "", ctx);
	assertEq(ctx.prompts.at(-1), 'compat (current: {"supportsDeveloperRole":false})');
});

test("a fallback picker with nothing to offer says so", async () => {
	const { pi } = registered("settings-fallback-empty");
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "fallback", "Choose a model"], { verboo: [GLM_MODEL] });
	ctx.unavailable.add("verboo");
	await pi.command("providers-settings", "", ctx);
	assertEq(ctx.lastMessage, "No provider with credentials has a chat model to fall back to");
});

test("the fallback picker lists providers with a model and saves the pair", async () => {
	const { pi, store } = registered("settings-fallback", {
		baseUrl: "https://code.verboo.ai/router/v1",
	});
	const other = { id: "m2", name: "M2", reasoning: false, contextWindow: 4096, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "fallback", "Choose a model", FALLBACK_OTHER, "m2 — M2"], { verboo: [GLM_MODEL], other: [other] });
	store.add("other", { baseUrl: "https://other.test/v1" });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(store.all().verboo.modelOverrides?.["glm-5.2"]?.fallback), JSON.stringify({ provider: "other", model: "m2" }));
	assertEq(ctx.offers.some((options) => options.includes(FALLBACK_OTHER)), true);
});

test("a fallback to the model itself is refused", async () => {
	const { pi, store } = registered("settings-fallback-self");
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "fallback", "Choose a model", FALLBACK_VERBOO, GLM], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides, undefined);
	assertEq(ctx.lastMessage, "glm-5.2 cannot fall back to a model that already falls back to it");
});

test("a fallback that closes a cycle is refused", async () => {
	const { pi, store } = registered("settings-fallback-cycle", {
		baseUrl: "https://code.verboo.ai/router/v1",
		modelOverrides: { "glm-5.2": { contextWindow: 262144 } },
	});
	store.add("other", {
		baseUrl: "https://other.test/v1",
		modelOverrides: { m2: { fallback: { provider: "verboo", model: "glm-5.2" } } },
	});
	const other = { id: "m2", name: "M2", reasoning: false, contextWindow: 4096, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "fallback", "Choose a model", FALLBACK_OTHER, "m2 — M2"], { verboo: [GLM_MODEL], other: [other] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(store.all().verboo.modelOverrides?.["glm-5.2"]), JSON.stringify({ contextWindow: 262144 }));
	assertEq(ctx.lastMessage.includes("already falls back to it"), true);
});
