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

const OTHER_MODEL = {
	id: "m2",
	name: "M2",
	reasoning: false,
	contextWindow: 4096,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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

test("an edit writes the override and re-registers the provider", async () => {
	const cases: Array<[string, string, string[], Array<string | undefined>, Record<string, unknown>, string?]> = [
		[
			"settings-edit",
			"a limit",
			["262144"],
			[VERBOO, GLM, "contextWindow", EDIT],
			{ "glm-5.2": { contextWindow: 262144 } },
			"Saved contextWindow for glm-5.2; open /model to apply",
		],
		["settings-cost", "a cost field", ["5"], [VERBOO, GLM, "cost.input", EDIT], { "glm-5.2": { cost: { input: 5 } } }],
		["settings-reasoning", "reasoning", [], [VERBOO, GLM, "reasoning", "false"], { "glm-5.2": { reasoning: false } }],
	];
	for (const [slug, label, answers, selections, expected, message] of cases) {
		const { pi, store } = registered(slug);
		const ctx = new FakeCommandContext(answers, selections, { verboo: [GLM_MODEL] });
		await pi.command("providers-settings", "", ctx);
		assertEq(JSON.stringify(store.all().verboo.modelOverrides), JSON.stringify(expected), label);
		assertEq(store.all().verboo.baseUrl, "https://code.verboo.ai/router/v1", label);
		assertEq(pi.unregistered.at(-1), "verboo", label);
		if (message !== undefined) assertEq(ctx.lastMessage, message, label);
	}
});

test("an invalid value warns and records nothing", async () => {
	const cases: Array<[string, string, string, string?]> = [
		["settings-invalid", "contextWindow", "abc"],
		["settings-json-invalid", "headers", "{oops", "headers expects valid JSON"],
		["settings-json-shape", "headers", '{"X-Tier":1}', "headers.X-Tier"],
	];
	for (const [slug, field, value, message] of cases) {
		const label = `${field} ${JSON.stringify(value)}`;
		const { pi, store } = registered(slug);
		const ctx = new FakeCommandContext([value], [VERBOO, GLM, field, EDIT], { verboo: [GLM_MODEL] });
		await pi.command("providers-settings", "", ctx);
		assertEq(store.all().verboo.modelOverrides, undefined, label);
		assertEq(ctx.notifications.at(-1)?.type, "warning", label);
		if (message !== undefined) assertEq(ctx.lastMessage.includes(message), true, label);
	}
});

test("clearing an override drops its field and the entry once it was the last one", async () => {
	const cases: Array<[string, Record<string, unknown>, string, string, unknown, string?]> = [
		[
			"settings-clear",
			{ "glm-5.2": { contextWindow: 262144 } },
			OVERRIDE,
			CLEAR,
			undefined,
			"Cleared the override for glm-5.2; open /model to apply",
		],
		[
			"settings-clear-field",
			{ "glm-5.2": { contextWindow: 262144, cost: { input: 5, output: 6 } } },
			"cost.input",
			CLEAR_FIELD,
			{ "glm-5.2": { contextWindow: 262144, cost: { output: 6 } } },
			"Cleared cost.input for glm-5.2; open /model to apply",
		],
		["settings-clear-last", { "glm-5.2": { contextWindow: 262144 } }, "contextWindow", CLEAR_FIELD, undefined],
	];
	for (const [slug, overrides, field, choice, expected, message] of cases) {
		const { pi, store } = registered(slug, { baseUrl: "https://code.verboo.ai/router/v1", modelOverrides: overrides as never });
		const ctx = new FakeCommandContext([], [VERBOO, GLM, field, choice], { verboo: [GLM_MODEL] });
		await pi.command("providers-settings", "", ctx);
		assertEq(JSON.stringify(store.all().verboo.modelOverrides), JSON.stringify(expected), `${field} via ${choice}`);
		assertEq(store.all().verboo.baseUrl, "https://code.verboo.ai/router/v1", `${field} via ${choice}`);
		if (message !== undefined) assertEq(ctx.lastMessage, message, `${field} via ${choice}`);
	}
});

test("an unfetched catalog falls back to typing the model id", async () => {
	const { pi, store } = registered("settings-manual");
	const ctx = new FakeCommandContext(["m2", "4096"], [VERBOO, "maxTokens", EDIT], {});
	await pi.command("providers-settings", "", ctx);
	assertEq(store.all().verboo.modelOverrides?.m2?.maxTokens, 4096);
});

test("cancelling at any level records nothing", async () => {
	const cases: Array<[string, string, Array<string | undefined>, Array<string | undefined>, number[]?]> = [
		["settings-cancel", "the provider select", [], [undefined]],
		["settings-cancel-value", "a value prompt", [undefined], [VERBOO, GLM, "contextWindow", EDIT], [4, 2]],
		["settings-cancel-model", "the model list", ["unused"], [VERBOO, undefined]],
	];
	for (const [slug, label, answers, selections, back] of cases) {
		const { pi, store } = registered(slug);
		const ctx = new FakeCommandContext(answers, selections, { verboo: [GLM_MODEL] });
		await pi.command("providers-settings", "", ctx);
		assertEq(JSON.stringify(ctx.notifications), "[]", label);
		assertEq(store.all().verboo.modelOverrides, undefined, label);
		assertEq(pi.unregistered.length, 0, label);
		if (back !== undefined) assertEq(JSON.stringify(ctx.offers[back[0]]), JSON.stringify(ctx.offers[back[1]]), label);
	}
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

test("a field offers clear only when it carries an override", async () => {
	const cases: Array<[string, string, string, Record<string, unknown> | undefined, string[]]> = [
		["settings-no-clear", "a field without an override", "cost.input", undefined, [EDIT]],
		["settings-clear-offer", "a field with an override", "contextWindow", { "glm-5.2": { contextWindow: 262144 } }, [EDIT, CLEAR_FIELD]],
	];
	for (const [slug, label, field, overrides, expected] of cases) {
		const { pi } = registered(slug, { baseUrl: "https://code.verboo.ai/router/v1", ...(overrides === undefined ? {} : { modelOverrides: overrides as never }) });
		const ctx = new FakeCommandContext([], [VERBOO, GLM, field, undefined], { verboo: [GLM_MODEL] });
		await pi.command("providers-settings", "", ctx);
		assertEq(JSON.stringify(ctx.offers[3]), JSON.stringify(expected), label);
	}
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

test("the modality select saves the pi modalities", async () => {
	const { pi, store } = registered("settings-input");
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "input", "text, image"], { verboo: [GLM_MODEL] });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(store.all().verboo.modelOverrides?.["glm-5.2"]?.input), JSON.stringify(["text", "image"]));
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

test("the fallback picker lists providers with a model and saves the pair", async () => {
	const { pi, store } = registered("settings-fallback", {
		baseUrl: "https://code.verboo.ai/router/v1",
	});
	const ctx = new FakeCommandContext([], [VERBOO, GLM, "fallback", "Choose a model", FALLBACK_OTHER, "m2 — M2"], { verboo: [GLM_MODEL], other: [OTHER_MODEL] });
	store.add("other", { baseUrl: "https://other.test/v1" });
	await pi.command("providers-settings", "", ctx);
	assertEq(JSON.stringify(store.all().verboo.modelOverrides?.["glm-5.2"]?.fallback), JSON.stringify({ provider: "other", model: "m2" }));
	assertEq(ctx.offers.some((options) => options.includes(FALLBACK_OTHER)), true);
});

test("the fallback picker refuses a target that cannot serve", async () => {
	const cases: Array<[string, string, Record<string, unknown> | undefined, boolean, boolean, Array<string | undefined>, unknown, string]> = [
		[
			"settings-fallback-empty",
			"nothing to offer",
			undefined,
			false,
			false,
			[VERBOO, GLM, "fallback", "Choose a model"],
			undefined,
			"No provider with credentials has a chat model to fall back to",
		],
		[
			"settings-fallback-self",
			"the model itself",
			undefined,
			true,
			false,
			[VERBOO, GLM, "fallback", "Choose a model", FALLBACK_VERBOO, GLM],
			undefined,
			"already falls back to it",
		],
		[
			"settings-fallback-cycle",
			"a model that falls back to it",
			{ "glm-5.2": { contextWindow: 262144 } },
			true,
			true,
			[VERBOO, GLM, "fallback", "Choose a model", FALLBACK_OTHER, "m2 — M2"],
			{ "glm-5.2": { contextWindow: 262144 } },
			"already falls back to it",
		],
	];
	for (const [slug, label, overrides, available, otherProvider, selections, expected, message] of cases) {
		const { pi, store } = registered(slug, {
			baseUrl: "https://code.verboo.ai/router/v1",
			...(overrides === undefined ? {} : { modelOverrides: overrides as never }),
		});
		if (otherProvider) {
			store.add("other", {
				baseUrl: "https://other.test/v1",
				modelOverrides: { m2: { fallback: { provider: "verboo", model: "glm-5.2" } } },
			});
		}
		const known = otherProvider ? { verboo: [GLM_MODEL], other: [OTHER_MODEL] } : { verboo: [GLM_MODEL] };
		const ctx = new FakeCommandContext([], selections, known);
		if (!available) ctx.unavailable.add("verboo");
		await pi.command("providers-settings", "", ctx);
		assertEq(JSON.stringify(store.all().verboo.modelOverrides), JSON.stringify(expected), label);
		assertEq(ctx.lastMessage.includes(message), true, label);
	}
});
