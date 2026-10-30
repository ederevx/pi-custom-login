import { spawnSync } from "node:child_process";

import { ModelCatalog } from "../src/model-catalog.ts";
import { CONTEXT_WINDOW_VARIABLE, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, MAX_TOKENS_VARIABLE, type CatalogRefreshContext, type ProviderEntry } from "../src/provider-config.ts";
import { assertEq, assertRejects, test } from "./harness.ts";

const CONFIG_MODULE = new URL("../src/provider-config.ts", import.meta.url).href;

const ENTRY: ProviderEntry = { name: "Verboo", baseUrl: "https://code.verboo.ai/router/v1" };

/** Loads the config module in a fresh process so module-load validation runs. */
function loadFresh(variable: string, value: string | undefined): { status: number | null; stderr: string; limits: Record<string, number> } {
	const env = { ...process.env };
	delete env[CONTEXT_WINDOW_VARIABLE];
	delete env[MAX_TOKENS_VARIABLE];
	if (value !== undefined) env[variable] = value;
	const script = `import * as c from "${CONFIG_MODULE}"; console.log(JSON.stringify({ [c.CONTEXT_WINDOW_VARIABLE]: c.DEFAULT_CONTEXT_WINDOW, [c.MAX_TOKENS_VARIABLE]: c.DEFAULT_MAX_TOKENS }));`;
	const run = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-transform-types", "--input-type=module", "-e", script], { env, encoding: "utf8" });
	return { status: run.status, stderr: run.stderr ?? "", limits: run.status === 0 ? JSON.parse(run.stdout.trim()) : {} };
}
const SIGNAL = new AbortController().signal;
const KEY = { type: "api_key", key: "k" };

interface Capture {
	requests: number;
	url?: string;
	headers?: Record<string, string>;
	persisted?: { models: readonly unknown[]; checkedAt: number };
}

const capture: Capture = { requests: 0 };

function respondWith(body: unknown, status = 200): void {
	globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
		capture.requests += 1;
		capture.url = url;
		capture.headers = init.headers as Record<string, string> | undefined;
		return { ok: status < 400, status, json: async () => body };
	}) as unknown as typeof fetch;
	reset();
}

function context(overrides: Partial<CatalogRefreshContext> = {}): CatalogRefreshContext {
	return {
		allowNetwork: true,
		signal: SIGNAL,
		publish: async (publication) => {
			capture.persisted = publication.persist;
			return true;
		},
		...overrides,
	};
}

function reset(): void {
	capture.requests = 0;
	capture.url = undefined;
	capture.headers = undefined;
	capture.persisted = undefined;
}

function networked(overrides: Partial<CatalogRefreshContext> = {}): CatalogRefreshContext {
	return context({ credential: KEY, ...overrides });
}

test("a catalog maps the fields pi needs", async () => {
	respondWith({
		data: [
			{ id: "glm-5.2", display_name: "GLM 5.2", context_window: 1000000, max_output_tokens: 32768, vision: true, reasoning: { effort_levels: ["high"] } },
			{ id: "qwen3.8-27b", context_window: 262144 },
		],
	});
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(capture.url, "https://code.verboo.ai/router/v1/models");
	assertEq(capture.headers?.Authorization, "Bearer k");
	assertEq(JSON.stringify(models), JSON.stringify([
		{
			id: "glm-5.2",
			name: "GLM 5.2",
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1000000,
			maxTokens: 32768,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		{
			id: "qwen3.8-27b",
			name: "qwen3.8-27b",
			api: "openai-completions",
			reasoning: false,
			input: ["text"],
			contextWindow: 262144,
			maxTokens: 16384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	]));
	assertEq(JSON.stringify(capture.persisted?.models), JSON.stringify(models));
	assertEq(typeof capture.persisted?.checkedAt, "number");
});

test("offline keeps the stored list without a request", async () => {
	respondWith({ data: [] });
	const stored = [{ id: "stored" }] as never;
	const models = await new ModelCatalog(ENTRY).models(context({ stored: { models: stored }, allowNetwork: false }));
	assertEq(models.length, 1);
	assertEq(capture.requests, 0);
});

test("no credential returns the stored list and asks no server", async () => {
	respondWith({ data: [] });
	const models = await new ModelCatalog(ENTRY).models(context());
	assertEq(models.length, 0);
	assertEq(capture.requests, 0);
});

test("a failed catalog rejects and persists nothing", async () => {
	respondWith({}, 401);
	await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "HTTP 401");
	assertEq(capture.persisted, undefined);
});

test("a body without a model list rejects", async () => {
	respondWith({ object: "list" });
	await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "no model list");
});

test("catalog model names leave compatibility to pi", async () => {
	respondWith({ data: ["deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", "glm-5.3-flash", "qwen3.8-27b", "mimo-v2.6-flash", "my-deepseek-wrapper"].map((id) => ({ id })) });
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(
		JSON.stringify(models.map((model) => model.compat)),
		JSON.stringify([null, null, null, null, null, null, null]),
	);
	assertEq(JSON.stringify(capture.persisted?.models), JSON.stringify(models));
});

const OLLAMA_METADATA = [
	{
		slug: "clef:27b",
		context_window: 65536,
		max_context_window: 65536,
		input_modalities: ["text", "image"],
		supported_reasoning_levels: [],
		visibility: "hide",
		supported_in_api: false,
	},
	{
		slug: "deepseek-v4.1-flash",
		display_name: "DeepSeek V4.1 Flash",
		context_window: 1048576,
		max_context_window: 1048576,
		input_modalities: ["text", "image"],
		supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "high" }, { effort: "max" }],
		truncation_policy: { mode: "tokens", limit: 10000 },
		visibility: "list",
		supported_in_api: true,
	},
	{
		slug: "kimi-k2.7-code",
		display_name: "Kimi K2.7 Code",
		context_window: 262144,
		max_context_window: 262144,
		input_modalities: ["text"],
		supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
		visibility: "list",
		supported_in_api: true,
	},
];

test("an ollama-shaped catalog takes missing metadata from its top-level models list", async () => {
	respondWith({
		object: "list",
		data: [
			{ id: "kimi-k2.7-code", object: "model", created: 1, owned_by: "ollama" },
			{ id: "clef:27b", object: "model", created: 1, owned_by: "ollama" },
			{ id: "deepseek-v4.1-flash", object: "model", created: 1, owned_by: "ollama" },
		],
		models: OLLAMA_METADATA,
	});
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(
		JSON.stringify(models.map((model) => [model.id, model.name, model.contextWindow, model.reasoning, model.input])),
		JSON.stringify([
			["kimi-k2.7-code", "Kimi K2.7 Code", 262144, true, ["text"]],
			["clef:27b", "clef:27b", 65536, false, ["text", "image"]],
			["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1048576, true, ["text", "image"]],
		]),
	);
	assertEq(JSON.stringify(models.map((model) => model.maxTokens)), JSON.stringify([DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS]));
	assertEq(JSON.stringify(capture.persisted?.models), JSON.stringify(models));
});

test("metadata for a model the catalog does not list adds nothing", async () => {
	respondWith({ data: [{ id: "model" }], models: [{ slug: "elsewhere", context_window: 4096 }] });
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(JSON.stringify(models.map((model) => model.contextWindow)), JSON.stringify([DEFAULT_CONTEXT_WINDOW]));
});

test("an OpenAI-shaped entry wins where the metadata disagrees", async () => {
	respondWith({
		data: [{ id: "model", display_name: "From entry", context_window: 1000000, max_output_tokens: 32768, vision: false, reasoning: { effort_levels: [] } }],
		models: [
			{
				slug: "model",
				display_name: "From metadata",
				context_window: 4096,
				max_output_tokens: 4096,
				input_modalities: ["text", "image"],
				supported_reasoning_levels: [{ effort: "high" }],
			},
		],
	});
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(
		JSON.stringify(models.map((model) => [model.name, model.contextWindow, model.maxTokens, model.reasoning, model.input])),
		JSON.stringify([["From entry", 1000000, 32768, false, ["text"]]]),
	);
});

test("a metadata max_context_window stands in for a missing context_window", async () => {
	respondWith({ data: [{ id: "model" }], models: [{ slug: "model", max_context_window: 524288 }] });
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(JSON.stringify(models.map((model) => model.contextWindow)), JSON.stringify([524288]));
});

test("a metadata max_output_tokens supplies a missing output limit", async () => {
	respondWith({ data: [{ id: "model" }], models: [{ slug: "model", max_output_tokens: 32000 }] });
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(JSON.stringify(models.map((model) => model.maxTokens)), JSON.stringify([32000]));
});

test("metadata whose context window exceeds its max_context_window rejects", async () => {
	respondWith({ data: [{ id: "model" }], models: [{ slug: "model", context_window: 262144, max_context_window: 131072 }] });
	await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "above its max_context_window");
	assertEq(capture.persisted, undefined);
});

const MALFORMED_METADATA: Array<[string, unknown]> = [
	["a non-list models field", { model: { context_window: 4096 } }],
	["a null metadata entry", [null]],
	["a metadata entry without a slug", [{ context_window: 4096 }]],
	["a blank metadata slug", [{ slug: "   " }]],
	["duplicate metadata slugs", [{ slug: "model" }, { slug: "model" }]],
	["a non-numeric context window", [{ slug: "model", context_window: "4096" }]],
	["a non-positive max_context_window", [{ slug: "model", max_context_window: 0 }]],
	["a non-string display name", [{ slug: "model", display_name: 7 }]],
	["non-list input modalities", [{ slug: "model", input_modalities: "image" }]],
	["a non-string modality", [{ slug: "model", input_modalities: ["text", 7] }]],
	["levels that are not a list", [{ slug: "model", supported_reasoning_levels: "high" }]],
	["a level without an effort", [{ slug: "model", supported_reasoning_levels: [{ effort: 7 }] }]],
];

for (const [description, models] of MALFORMED_METADATA) {
	test(`a catalog with ${description} rejects before persisting`, async () => {
		respondWith({ data: [{ id: "model" }], models });
		await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "model catalog");
		assertEq(capture.persisted, undefined);
	});
}

for (const models of [undefined, []]) {
	test(`a catalog whose models field is ${String(models)} adds no metadata`, async () => {
		respondWith({ data: [{ id: "model" }], models });
		const models_ = await new ModelCatalog(ENTRY).models(networked());
		assertEq(JSON.stringify(models_.map((model) => model.contextWindow)), JSON.stringify([DEFAULT_CONTEXT_WINDOW]));
	});
}

test("an empty catalog is valid and replaces the stored list", async () => {
	respondWith({ object: "list", data: [], models: [] });
	const models = await new ModelCatalog(ENTRY).models(networked({ stored: { models: [{ id: "stored" }] as never } }));
	assertEq(models.length, 0);
	assertEq(JSON.stringify(capture.persisted?.models), JSON.stringify([]));
});

test("metadata with only the none effort supports no reasoning", async () => {
	respondWith({ data: [{ id: "model" }], models: [{ slug: "model", supported_reasoning_levels: [{ effort: "none" }] }] });
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(JSON.stringify(models.map((model) => model.reasoning)), JSON.stringify([false]));
});

test("explicit entry values leave contradictory metadata unread", async () => {
	respondWith({
		data: [{ id: "model", context_window: 1000000, vision: true, reasoning: { effort_levels: ["high"] } }],
		models: [{ slug: "model", context_window: 262144, max_context_window: 131072 }],
	});
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(
		JSON.stringify(models.map((model) => [model.contextWindow, model.reasoning, model.input])),
		JSON.stringify([[1000000, true, ["text", "image"]]]),
	);
	assertEq(JSON.stringify(capture.persisted?.models), JSON.stringify(models));
});

test("a blank metadata display name falls back to the id", async () => {
	respondWith({ data: [{ id: "model" }], models: [{ slug: "model", display_name: "   " }] });
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(JSON.stringify(models.map((model) => model.name)), JSON.stringify(["model"]));
});

test("an explicit blank entry name wins over a metadata name", async () => {
	respondWith({ data: [{ id: "model", display_name: "" }], models: [{ slug: "model", display_name: "From metadata" }] });
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(JSON.stringify(models.map((model) => model.name)), JSON.stringify([""]));
});

test("metadata fields the entry already supplies are never validated", async () => {
	respondWith({
		data: [{ id: "model", display_name: "Entry", context_window: 1000000, max_output_tokens: 32768, vision: true, reasoning: { effort_levels: ["high"] } }],
		models: [
			{
				slug: "model",
				display_name: 7,
				context_window: 1.5,
				max_context_window: 1.5,
				max_output_tokens: 1.5,
				input_modalities: "image",
				supported_reasoning_levels: "high",
			},
		],
	});
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(
		JSON.stringify(models.map((model) => [model.name, model.contextWindow, model.maxTokens, model.reasoning, model.input])),
		JSON.stringify([["Entry", 1000000, 32768, true, ["text", "image"]]]),
	);
	assertEq(JSON.stringify(capture.persisted?.models), JSON.stringify(models));
});

test("a duplicate model id rejects before persisting", async () => {
	respondWith({ data: [{ id: "model", context_window: 4096 }, { id: "model" }] });
	await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "has a duplicate model id model");
	assertEq(capture.persisted, undefined);
});

test("a valid model ahead of an invalid metadata entry publishes nothing", async () => {
	respondWith({
		data: [{ id: "valid" }, { id: "model" }],
		models: [{ slug: "valid", context_window: 4096 }, { slug: "model", context_window: 1.5 }],
	});
	await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "has an invalid context_window");
	assertEq(capture.persisted, undefined);
});

test("catalog token prices become per-million costs", async () => {
	respondWith({
		data: [
			{
				id: "priced",
				pricing: {
					prompt: "0.000001",
					completion: "0.000002",
					input_cache_read: "0.0000005",
					input_cache_write: "0.00000125",
					overrides: [{ min_prompt_tokens: 100, prompt: "1" }],
				},
			},
			{ id: "unpriced" },
		],
	});
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(JSON.stringify(models.map((model) => model.cost)), JSON.stringify([
		{ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	]));
	assertEq(JSON.stringify(capture.persisted?.models), JSON.stringify(models));
});

test("partial pricing preserves supplied costs", async () => {
	respondWith({ data: [{ id: "partial", pricing: { completion: "0.000002" } }] });
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(JSON.stringify(models[0].cost), JSON.stringify({
		input: 0, output: 2, cacheRead: 0, cacheWrite: 0,
	}));
});

for (const pricing of [null, [], "0"]) {
	test(`invalid pricing ${JSON.stringify(pricing)} rejects`, async () => {
		respondWith({ data: [{ id: "valid" }, { id: "bad", pricing }] });
		await assertRejects(
			() => new ModelCatalog(ENTRY).models(networked()),
			"has an invalid pricing",
		);
		assertEq(capture.persisted, undefined);
	});
}

for (const field of ["prompt", "completion", "input_cache_read", "input_cache_write"]) {
	for (const value of [0.3, null, true, {}, [], "", " ", "-1", "1e-6", "0x10", "oops", "9".repeat(400)]) {
		test(`invalid pricing.${field} ${JSON.stringify(value)} rejects`, async () => {
			respondWith({
				data: [{ id: "valid" }, { id: "bad", pricing: { [field]: value } }],
			});
			await assertRejects(
				() => new ModelCatalog(ENTRY).models(networked()),
				"model catalog",
			);
			assertEq(capture.persisted, undefined);
		});
	}
}

const UNUSABLE_LIMITS = [1.5, Number.MAX_SAFE_INTEGER + 1];

for (const value of UNUSABLE_LIMITS) {
	test(`an entry limit of ${value} rejects before persisting`, async () => {
		respondWith({ data: [{ id: "model", max_output_tokens: value }] });
		await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "has an invalid max_output_tokens");
		assertEq(capture.persisted, undefined);
	});

	test(`a metadata limit of ${value} rejects before persisting`, async () => {
		respondWith({ data: [{ id: "model" }], models: [{ slug: "model", max_output_tokens: value }] });
		await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "has an invalid max_output_tokens");
		assertEq(capture.persisted, undefined);
	});
}


for (const value of [0, -1, "32768", null, true, {}, [], NaN, Infinity]) {
	test(`a catalog with max_output_tokens ${String(value)} rejects before persisting`, async () => {
		respondWith({ data: [{ id: "valid" }, { id: "model", max_output_tokens: value }] });
		await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "Verboo: model catalog has an invalid max_output_tokens");
		assertEq(capture.persisted, undefined);
	});
}

const VALID = { id: "valid" };
const MALFORMED: Array<[string, unknown]> = [
	["a non-object entry", [null]],
	["a missing id", [{}]],
	["an empty id", [{ id: "   " }]],
	["a non-string name", [{ id: "model", display_name: 7 }]],
	["a non-positive context window", [{ id: "model", context_window: 0 }]],
	["a non-boolean vision", [{ id: "model", vision: "yes" }]],
	["non-list effort levels", [{ id: "model", reasoning: { effort_levels: "high" } }]],
	["non-string effort levels", [{ id: "model", reasoning: { effort_levels: [7] } }]],
	["a valid entry ahead of a bad one", [VALID, { id: "model", vision: null }]],
];

for (const [description, data] of MALFORMED) {
	test(`a catalog with ${description} rejects before persisting`, async () => {
		respondWith({ data });
		await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "model catalog");
		assertEq(capture.persisted, undefined);
	});
}

const FALLBACKS: Array<[string, number]> = [
	[CONTEXT_WINDOW_VARIABLE, 131072],
	[MAX_TOKENS_VARIABLE, 16384],
];

for (const [variable, builtin] of FALLBACKS) {
	for (const value of ["0", "-1", "abc", "", "1.5", " 16384", "1e5", String(Number.MAX_SAFE_INTEGER + 1)]) {
		test(`${variable}=${JSON.stringify(value)} stops the extension loading`, () => {
			const loaded = loadFresh(variable, value);
			assertEq(loaded.status !== 0, true, `${variable}=${value} loaded anyway`);
			assertEq(loaded.stderr.includes(`${variable} is set but invalid`), true, loaded.stderr.slice(-300));
		});
	}

	test(`${variable} unset uses the built-in limit`, () => {
		assertEq(loadFresh(variable, undefined).limits[variable], builtin);
	});

	test(`${variable} replaces the built-in limit`, () => {
		assertEq(loadFresh(variable, "4096").limits[variable], 4096);
	});
}
