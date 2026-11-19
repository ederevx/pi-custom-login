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
			compat: { supportsDeveloperRole: false },
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
			compat: { supportsDeveloperRole: false },
		},
	]));
	assertEq(JSON.stringify(capture.persisted?.models.map((model) => "compat" in model)), JSON.stringify([false, false]));
	assertEq(typeof capture.persisted?.checkedAt, "number");
});

test("an offline or credential-less catalog keeps the stored list and asks no server", async () => {
	const cases: Array<[string, readonly unknown[], Partial<CatalogRefreshContext>, number]> = [
		["an offline catalog", [{ id: "stored" }], { allowNetwork: false }, 1],
		["a catalog with no credential", [], {}, 0],
	];
	for (const [label, stored, overrides, expected] of cases) {
		respondWith({ data: [] });
		const models = await new ModelCatalog(ENTRY).models(context({ stored: { models: stored as never }, ...overrides }));
		assertEq(models.length, expected, label);
		assertEq(
			JSON.stringify(models.map((model) => model.compat)),
			JSON.stringify(models.map(() => ({ supportsDeveloperRole: false }))),
			label,
		);
		assertEq(capture.requests, 0, label);
	}
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

test("the developer-role baseline applies to every model regardless of name", async () => {
	respondWith({ data: ["deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", "glm-5.3-flash", "qwen3.8-27b", "mimo-v2.6-flash", "my-deepseek-wrapper"].map((id) => ({ id })) });
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(
		JSON.stringify(models.map((model) => model.compat)),
		JSON.stringify(models.map(() => ({ supportsDeveloperRole: false }))),
	);
	assertEq(JSON.stringify(capture.persisted?.models.map((model) => "compat" in model)), JSON.stringify(models.map(() => false)));
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
	assertEq(JSON.stringify(capture.persisted?.models.map((model) => "compat" in model)), JSON.stringify([false, false, false]));
});

test("a catalog shape supplies every model field pi wants", async () => {
	const cases: Array<[string, unknown, unknown]> = [
		[
			"the OpenCode Go shape",
			{
				data: [
					{
						id: "deepseek-v4.1-flash",
						name: "DeepSeek V4.1 Flash",
						limit: { context: 1000000, output: 384000 },
						modalities: { input: ["text", "image/jpeg", "image/png", "image/gif", "image/webp"], output: ["text"] },
						capabilities: { reasoning: { supported: true, effort: ["low", "high", "max"] } },
						cost: { text: { input: { price: 0.15, cache: { read: 0.003, write: 0.0001 } }, output: { price: 0.6 } } },
					},
				],
			},
			[
				{
					id: "deepseek-v4.1-flash",
					name: "DeepSeek V4.1 Flash",
					api: "openai-completions",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 1000000,
					maxTokens: 384000,
					cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.0001 },
					compat: { supportsDeveloperRole: false },
				},
			],
		],
		[
			"the Reka shape",
			{
				data: [
					{
						id: "qwen/qwen3.6-27b",
						name: "Qwen3.6 27B",
						context_length: 262144,
						max_output_length: 32768,
						input_modalities: ["text"],
						supported_features: ["tools", "json_mode", "reasoning"],
						pricing: { prompt: "0.00000029", completion: "0.00000195" },
					},
				],
			},
			[
				{
					id: "qwen/qwen3.6-27b",
					name: "Qwen3.6 27B",
					api: "openai-completions",
					reasoning: true,
					input: ["text"],
					contextWindow: 262144,
					maxTokens: 32768,
					cost: { input: 0.29, output: 1.95, cacheRead: 0, cacheWrite: 0 },
					compat: { supportsDeveloperRole: false },
				},
			],
		],
	];
	for (const [label, body, expected] of cases) {
		respondWith(body);
		const models = await new ModelCatalog(ENTRY).models(networked());
		assertEq(JSON.stringify(models), JSON.stringify(expected), label);
	}
});

test("metadata for a model the catalog does not list adds nothing", async () => {
	respondWith({ data: [{ id: "model" }], models: [{ slug: "elsewhere", context_window: 4096 }] });
	const models = await new ModelCatalog(ENTRY).models(networked());
	assertEq(JSON.stringify(models.map((model) => model.contextWindow)), JSON.stringify([DEFAULT_CONTEXT_WINDOW]));
});

test("an entry-declared value wins over the metadata and the alternative shape", async () => {
	const cases: Array<[string, unknown, unknown, unknown[]]> = [
		[
			"an OpenAI-shaped entry against disagreeing metadata",
			{ data: [{ id: "model", display_name: "From entry", context_window: 1000000, max_output_tokens: 32768, vision: false, reasoning: { effort_levels: [] } }] },
			[
				{
					slug: "model",
					display_name: "From metadata",
					context_window: 4096,
					max_output_tokens: 4096,
					input_modalities: ["text", "image"],
					supported_reasoning_levels: [{ effort: "high" }],
				},
			],
			["From entry", 1000000, 32768, false, ["text"]],
		],
		[
			"explicit entry values against contradictory metadata",
			{ data: [{ id: "model", context_window: 1000000, vision: true, reasoning: { effort_levels: ["high"] } }] },
			[{ slug: "model", context_window: 262144, max_context_window: 131072 }],
			["model", 1000000, DEFAULT_MAX_TOKENS, true, ["text", "image"]],
		],
		[
			"metadata fields the entry already supplies",
			{ data: [{ id: "model", display_name: "Entry", context_window: 1000000, max_output_tokens: 32768, vision: true, reasoning: { effort_levels: ["high"] } }] },
			[
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
			["Entry", 1000000, 32768, true, ["text", "image"]],
		],
		[
			"a declared flat field over an alternative shape",
			{
				data: [
					{
						id: "m",
						display_name: "Flat",
						name: "Nested",
						context_window: 1000,
						limit: { context: 2000, output: 300 },
						max_output_tokens: 100,
						vision: false,
						modalities: { input: ["image/png"] },
						reasoning: { effort_levels: ["high"] },
						capabilities: { reasoning: { supported: false } },
						pricing: { prompt: "0.000001" },
						cost: { text: { input: { price: 9 }, output: { price: 9 } } },
					},
				],
			},
			undefined,
			["Flat", 1000, 100, true, ["text"]],
		],
	];
	for (const [label, body, metadata, expected] of cases) {
		respondWith(metadata === undefined ? body : { ...(body as Record<string, unknown>), models: metadata });
		const models = await new ModelCatalog(ENTRY).models(networked());
		assertEq(
			JSON.stringify(models.map((model) => [model.name, model.contextWindow, model.maxTokens, model.reasoning, model.input])),
			JSON.stringify([expected]),
			label,
		);
		assertEq(JSON.stringify(capture.persisted?.models.map((model) => "compat" in model)), JSON.stringify([false]), label);
	}
});

test("a missing limit is filled from the metadata, an entry alias, or the ceiling", async () => {
	const cases: Array<[string, ProviderEntry, unknown, number, number]> = [
		["metadata max_context_window for a missing context_window", { id: "model" }, [{ slug: "model", max_context_window: 524288 }], 524288, DEFAULT_MAX_TOKENS],
		["metadata max_output_tokens for a missing output limit", { id: "model" }, [{ slug: "model", max_output_tokens: 32000 }], DEFAULT_CONTEXT_WINDOW, 32000],
		["an entry-level max_context_window for the window", { id: "m", max_context_window: 4096 }, undefined, 4096, DEFAULT_MAX_TOKENS],
		["an entry-level ceiling above the indexed window", { id: "model", max_context_window: 400000 }, [{ slug: "model", context_window: 200000 }], 200000, DEFAULT_MAX_TOKENS],
	];
	for (const [label, entry, metadata, contextWindow, maxTokens] of cases) {
		respondWith(metadata === undefined ? { data: [entry] } : { data: [entry], models: metadata });
		const models = await new ModelCatalog(ENTRY).models(networked());
		assertEq(models.map((model) => model.contextWindow).join(","), String(contextWindow), label);
		assertEq(models.map((model) => model.maxTokens).join(","), String(maxTokens), label);
	}
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

test("a malformed models list rejects before persisting", async () => {
	for (const [label, models] of MALFORMED_METADATA) {
		respondWith({ data: [{ id: "model" }], models });
		await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "model catalog", label);
		assertEq(capture.persisted, undefined, label);
	}
});

test("a models field that is absent or empty adds no metadata", async () => {
	for (const models of [undefined, []]) {
		const label = `a models field of ${String(models)}`;
		respondWith({ data: [{ id: "model" }], models });
		const published = await new ModelCatalog(ENTRY).models(networked());
		assertEq(JSON.stringify(published.map((model) => model.contextWindow)), JSON.stringify([DEFAULT_CONTEXT_WINDOW]), label);
	}
});

test("an empty catalog is valid and replaces the stored list", async () => {
	respondWith({ object: "list", data: [], models: [] });
	const models = await new ModelCatalog(ENTRY).models(networked({ stored: { models: [{ id: "stored" }] as never } }));
	assertEq(models.length, 0);
	assertEq(JSON.stringify(capture.persisted?.models), JSON.stringify([]));
});

test("reasoning is declared only by an explicit flag or a level above none", async () => {
	const cases: Array<[string, unknown, unknown, boolean]> = [
		["a true reasoning flag", { id: "m", reasoning: true }, undefined, true],
		["a false reasoning flag", { id: "m", reasoning: false }, undefined, false],
		["a true capabilities flag", { id: "m", capabilities: { reasoning: true } }, undefined, true],
		["capabilities.reasoning without levels or a supported flag", { id: "m", capabilities: { reasoning: {} } }, undefined, false],
		["metadata with only the none effort", { id: "model" }, [{ slug: "model", supported_reasoning_levels: [{ effort: "none" }] }], false],
		["a feature list without reasoning against a supplementary effort", { id: "model", supported_features: [] }, [{ slug: "model", supported_reasoning_levels: [{ effort: "high" }] }], false],
	];
	for (const [label, entry, metadata, reasoning] of cases) {
		respondWith(metadata === undefined ? { data: [entry] } : { data: [entry], models: metadata });
		const models = await new ModelCatalog(ENTRY).models(networked());
		assertEq(models[0].reasoning, reasoning, label);
	}
});

test("a model name falls back to the id only where nothing names it", async () => {
	const cases: Array<[string, unknown, string]> = [
		["a blank metadata display name", { data: [{ id: "model" }], models: [{ slug: "model", display_name: "   " }] }, "model"],
		["an explicit blank entry name over a metadata name", { data: [{ id: "model", display_name: "" }], models: [{ slug: "model", display_name: "From metadata" }] }, ""],
	];
	for (const [label, body, name] of cases) {
		respondWith(body);
		const models = await new ModelCatalog(ENTRY).models(networked());
		assertEq(JSON.stringify(models.map((model) => model.name)), JSON.stringify([name]), label);
	}
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
	const cases: Array<[string, unknown, unknown[]]> = [
		[
			"a priced and an unpriced model",
			{
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
			},
			[
				{ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			],
		],
		[
			"a cache write priced per retention window",
			{
				data: [{
					id: "windowed",
					cost: {
						text: {
							input: { price: 1, cache: { read: 0.5, write: { "30m": 0.125, "12h": 0.25 } } },
							output: { price: 2 },
						},
					},
				}],
			},
			[{ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 }],
		],
	];
	for (const [label, body, expected] of cases) {
		respondWith(body);
		const models = await new ModelCatalog(ENTRY).models(networked());
		assertEq(JSON.stringify(models.map((model) => model.cost)), JSON.stringify(expected), label);
		assertEq(JSON.stringify(capture.persisted?.models), JSON.stringify(models.map((model) => ({ ...model, compat: undefined }))), label);
	}
});

test("partial pricing and price sentinels preserve the prices supplied", async () => {
	const cases: Array<[string, unknown, unknown[]]> = [
		[
			"only one price supplied",
			{ data: [{ id: "partial", pricing: { completion: "0.000002" } }] },
			[{ input: 0, output: 2, cacheRead: 0, cacheWrite: 0 }],
		],
	];
	for (const [field, costField] of [
		["prompt", "input"],
		["completion", "output"],
		["input_cache_read", "cacheRead"],
		["input_cache_write", "cacheWrite"],
	] as const) {
		const variable = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 };
		variable[costField] = 0;
		cases.push([
			`the ${field} sentinel`,
			{
				data: [
					{
						id: "variable",
						pricing: {
							prompt: "0.000001",
							completion: "0.000002",
							input_cache_read: "0.0000005",
							input_cache_write: "0.00000125",
							[field]: "-1",
						},
					},
					{ id: "zero", pricing: { prompt: "0" } },
				],
			},
			[variable, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
		]);
	}
	for (const [label, body, expected] of cases) {
		respondWith(body);
		const models = await new ModelCatalog(ENTRY).models(networked());
		assertEq(JSON.stringify(models.map((model) => model.cost)), JSON.stringify(expected), label);
		assertEq(JSON.stringify(capture.persisted?.models), JSON.stringify(models.map((model) => ({ ...model, compat: undefined }))), label);
	}
});

test("a cache write the catalog cannot read rejects before persisting", async () => {
	for (const write of [{}, { "30m": -1 }, { "30m": "0.125" }, []]) {
		const label = `a cache write of ${JSON.stringify(write)}`;
		respondWith({
			data: [{ id: "valid" }, { id: "bad", cost: { text: { input: { cache: { write } } } } }],
		});
		await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "has an invalid cost.text.input.cache.write", label);
		assertEq(capture.persisted, undefined, label);
	}
});

test("a pricing value that is not an object rejects before persisting", async () => {
	for (const pricing of [null, [], "0"]) {
		const label = `pricing ${JSON.stringify(pricing)}`;
		respondWith({ data: [{ id: "valid" }, { id: "bad", pricing }] });
		await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "has an invalid pricing", label);
		assertEq(capture.persisted, undefined, label);
	}
});

test("a pricing number the catalog cannot convert rejects before persisting", async () => {
	const fields = ["prompt", "completion", "input_cache_read", "input_cache_write"];
	const values: unknown[] = [0.3, -1, null, true, {}, [], "", " ", "-2", "-1.0", "1e-6", "0x10", "oops", "9".repeat(400)];
	for (const field of fields) {
		for (const value of values) {
			const label = `pricing.${field} ${JSON.stringify(value)}`;
			respondWith({ data: [{ id: "valid" }, { id: "bad", pricing: { [field]: value } }] });
			await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "model catalog", label);
			assertEq(capture.persisted, undefined, label);
		}
	}
});

test("a limit the catalog cannot use rejects before persisting", async () => {
	const cases: Array<[string, unknown, unknown]> = [];
	for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
		cases.push([`an entry limit of ${value}`, { data: [{ id: "model", max_output_tokens: value }] }, undefined]);
		cases.push([`a metadata limit of ${value}`, { data: [{ id: "model" }] }, [{ slug: "model", max_output_tokens: value }]]);
	}
	for (const value of [0, -1, "32768", null, true, {}, [], NaN, Infinity]) {
		cases.push([`max_output_tokens ${String(value)}`, { data: [{ id: "valid" }, { id: "model", max_output_tokens: value }] }, undefined]);
	}
	for (const [label, body, models] of cases) {
		respondWith(models === undefined ? body : { ...(body as Record<string, unknown>), models });
		await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "has an invalid max_output_tokens", label);
		assertEq(capture.persisted, undefined, label);
	}
});

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

test("a malformed catalog entry rejects before persisting", async () => {
	for (const [label, data] of MALFORMED) {
		respondWith({ data });
		await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), "model catalog", label);
		assertEq(capture.persisted, undefined, label);
	}
});

const FALLBACKS: Array<[string, number]> = [
	[CONTEXT_WINDOW_VARIABLE, 131072],
	[MAX_TOKENS_VARIABLE, 16384],
];

test("an invalid limit variable stops the extension loading", async () => {
	for (const [variable] of FALLBACKS) {
		for (const value of ["0", "-1", "abc", "", "1.5", " 16384", "1e5", String(Number.MAX_SAFE_INTEGER + 1)]) {
			const label = `${variable}=${JSON.stringify(value)}`;
			const loaded = loadFresh(variable, value);
			assertEq(loaded.status !== 0, true, `${label} loaded anyway`);
			assertEq(loaded.stderr.includes(`${variable} is set but invalid`), true, `${label} — ${loaded.stderr.slice(-300)}`);
		}
	}
});

test("an unset limit variable uses the built-in limit", async () => {
	for (const [variable, builtin] of FALLBACKS) {
		assertEq(loadFresh(variable, undefined).limits[variable], builtin, variable);
	}
});

test("a limit variable replaces the built-in limit", async () => {
	for (const [variable] of FALLBACKS) {
		assertEq(loadFresh(variable, "4096").limits[variable], 4096, variable);
	}
});

test("an override wins over the catalog while the raw list is persisted", async () => {
	respondWith({
		data: [
			{
				id: "glm-5.2",
				display_name: "GLM 5.2",
				context_window: 1000000,
				max_output_tokens: 32768,
				vision: true,
				reasoning: { effort_levels: ["high"] },
				pricing: { prompt: "0.000001", completion: "0.000002" },
			},
		],
	});
	const entry: ProviderEntry = {
		...ENTRY,
		modelOverrides: {
			"glm-5.2": { name: "Renamed", reasoning: false, contextWindow: 262144, maxTokens: 8192, cost: { input: 5 } },
		},
	};
	const models = await new ModelCatalog(entry).models(networked());
	assertEq(
		JSON.stringify(models[0]),
		JSON.stringify({
			id: "glm-5.2",
			name: "Renamed",
			api: "openai-completions",
			reasoning: false,
			input: ["text", "image"],
			contextWindow: 262144,
			maxTokens: 8192,
			cost: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsDeveloperRole: false },
		}),
	);
	assertEq(
		JSON.stringify(capture.persisted?.models?.[0]),
		JSON.stringify({
			id: "glm-5.2",
			name: "GLM 5.2",
			api: "openai-completions",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1000000,
			maxTokens: 32768,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		}),
	);
});

test("the stored list is overridden offline too", async () => {
	respondWith({ data: [] });
	const stored = [{ id: "m", contextWindow: 1000 }] as never;
	const entry: ProviderEntry = { baseUrl: "https://code.verboo.ai/router/v1", modelOverrides: { m: { contextWindow: 4096 } } };
	const models = await new ModelCatalog(entry).models(context({ stored: { models: stored }, allowNetwork: false }));
	assertEq(models[0].contextWindow, 4096);
	assertEq(capture.requests, 0);
});

test("an override for a model the catalog does not list changes nothing", async () => {
	respondWith({ data: [{ id: "m" }] });
	const entry: ProviderEntry = { baseUrl: "https://code.verboo.ai/router/v1", modelOverrides: { elsewhere: { contextWindow: 4096 } } };
	const models = await new ModelCatalog(entry).models(networked());
	assertEq(JSON.stringify(models.map((model) => model.contextWindow)), JSON.stringify([DEFAULT_CONTEXT_WINDOW]));
});

test("an override sets every field pi publishes", async () => {
	respondWith({ data: [{ id: "m" }] });
	const entry: ProviderEntry = {
		baseUrl: "https://code.verboo.ai/router/v1",
		modelOverrides: {
			m: {
				input: ["text", "image"],
				inputLimits: { maxRequestBytes: 1000, images: { resize: { maxWidth: 800 }, maxPerRequest: 3 } },
				promptCache: { short: 300, long: 3600 },
				samplingParams: { top_p: 0.9 },
				samplingParamsByThinkingLevel: { high: { temperature: 0.2 } },
				thinkingLevelMap: { off: null, high: "high" },
				headers: { "X-Tier": "fast" },
				compat: { supportsReasoningEffort: false },
				cost: { tiers: [{ inputTokensAbove: 0, input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }] },
			},
		},
	};
	const model = (await new ModelCatalog(entry).models(networked()))[0] as unknown as Record<string, unknown>;
	assertEq(JSON.stringify(model.input), JSON.stringify(["text", "image"]));
	assertEq(JSON.stringify(model.inputLimits), JSON.stringify({ maxRequestBytes: 1000, images: { resize: { maxWidth: 800 }, maxPerRequest: 3 } }));
	assertEq(JSON.stringify(model.promptCache), JSON.stringify({ short: 300, long: 3600 }));
	assertEq(JSON.stringify(model.samplingParams), JSON.stringify({ top_p: 0.9 }));
	assertEq(JSON.stringify(model.samplingParamsByThinkingLevel), JSON.stringify({ high: { temperature: 0.2 } }));
	assertEq(JSON.stringify(model.thinkingLevelMap), JSON.stringify({ off: null, high: "high" }));
	assertEq(JSON.stringify(model.headers), JSON.stringify({ "X-Tier": "fast" }));
	assertEq(JSON.stringify(model.cost), JSON.stringify({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 0, input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }] }));
});

test("an object override merges while an array replaces", async () => {
	respondWith({ data: [{ id: "m", vision: true, pricing: { prompt: "0.000001", completion: "0.000002" } }] });
	const entry: ProviderEntry = {
		baseUrl: "https://code.verboo.ai/router/v1",
		modelOverrides: { m: { input: ["text"], cost: { input: 5 } } },
	};
	const model = (await new ModelCatalog(entry).models(networked()))[0];
	assertEq(JSON.stringify(model.input), JSON.stringify(["text"]));
	assertEq(JSON.stringify(model.cost), JSON.stringify({ input: 5, output: 2, cacheRead: 0, cacheWrite: 0 }));
});

test("a compat override layers over the developer-role baseline", async () => {
	respondWith({ data: [{ id: "m" }, { id: "n" }] });
	const baseUrl = "https://code.verboo.ai/router/v1";
	const layered = await new ModelCatalog({ baseUrl, modelOverrides: { m: { compat: { supportsReasoningEffort: false } } } }).models(networked());
	assertEq(JSON.stringify(layered[0].compat), JSON.stringify({ supportsDeveloperRole: false, supportsReasoningEffort: false }));
	const flipped = await new ModelCatalog({ baseUrl, modelOverrides: { n: { compat: { supportsDeveloperRole: true } } } }).models(networked());
	assertEq(JSON.stringify(flipped[1].compat), JSON.stringify({ supportsDeveloperRole: true }));
});

test("an override the catalog refuses rejects before any request", async () => {
	const cases: Array<[string, unknown]> = [
		["a non-string name", { name: 7 }],
		["a blank name", { name: "   " }],
		["a non-boolean reasoning", { reasoning: "yes" }],
		["a non-integer context window", { contextWindow: 1.5 }],
		["a non-positive max tokens", { maxTokens: 0 }],
		["a negative cost", { cost: { input: -1 } }],
		["a non-number cost", { cost: { output: "3" } }],
		["an unknown key", { turbo: true }],
		["an unknown cost key", { cost: { tax: 1 } }],
		["a null override", null],
		["a non-object cost", { cost: 5 }],
		["an api key", { api: "anthropic-messages" }],
		["a baseUrl key", { baseUrl: "https://example.test/v1" }],
		["an input without text", { input: ["image"] }],
		["an unknown modality", { input: ["text", "audio"] }],
		["a duplicated modality", { input: ["text", "text"] }],
		["a tier missing a price", { cost: { tiers: [{ inputTokensAbove: 0, input: 1, output: 1, cacheRead: 0 }] } }],
		["a negative tier threshold", { cost: { tiers: [{ inputTokensAbove: -1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }] } }],
		["a non-array tier list", { cost: { tiers: {} } }],
		["an unknown input limit", { inputLimits: { maxOutputBytes: 1 } }],
		["a zero image limit", { inputLimits: { images: { maxPerRequest: 0 } } }],
		["an unknown resize limit", { inputLimits: { images: { resize: { maxDepth: 1 } } } }],
		["a non-string header", { headers: { "X-Tier": 1 } }],
		["a numeric thinking level", { thinkingLevelMap: { high: 2 } }],
		["a non-object sampling params", { samplingParams: 5 }],
		["a non-object sampling params level", { samplingParamsByThinkingLevel: { high: "top_p" } }],
		["a negative prompt cache lifetime", { promptCache: { short: -1 } }],
		["a non-object compat", { compat: "fast" }],
		["a prompt cache tier pi does not define", { promptCache: { medium: 60 } }],
		["a fallback without a model", { fallback: { provider: "other" } }],
		["a blank fallback provider", { fallback: { provider: " ", model: "b" } }],
		["a fallback with an extra key", { fallback: { provider: "other", model: "b", api: "x" } }],
	];
	for (const [label, override] of cases) {
		const row = `an override with ${label}`;
		respondWith({ data: [{ id: "m" }] });
		const entry: ProviderEntry = { baseUrl: "https://code.verboo.ai/router/v1", modelOverrides: { m: override as never } };
		await assertRejects(() => new ModelCatalog(entry).models(networked()), "model catalog", row);
		assertEq(capture.requests, 0, row);
		assertEq(capture.persisted, undefined, row);
	}
});

test("a fallback is stored for the failover and never reaches the model", async () => {
	respondWith({ data: [{ id: "m" }] });
	const entry: ProviderEntry = {
		baseUrl: "https://code.verboo.ai/router/v1",
		modelOverrides: { m: { fallback: { provider: "other", model: "b" } } },
	};
	const model = (await new ModelCatalog(entry).models(networked()))[0] as unknown as Record<string, unknown>;
	assertEq("fallback" in model, false);
	assertEq(JSON.stringify(entry.modelOverrides?.m.fallback), JSON.stringify({ provider: "other", model: "b" }));
});

test("a malformed shape nothing consumed does not invalidate the entry", async () => {
	respondWith({ data: [{ id: "m", context_window: 200000, max_output_tokens: 8192, limit: "1M" }] });
	const model = (await new ModelCatalog(ENTRY).models(networked()))[0];
	assertEq(model.contextWindow, 200000);
	assertEq(model.maxTokens, 8192);
});

test("an alternative shape the catalog cannot read rejects and persists nothing", async () => {
	const cases: Array<[string, Record<string, unknown>, string]> = [
		["a non-object limit", { id: "m", limit: "1M" }, "invalid limit"],
		["a non-integer limit.context", { id: "m", limit: { context: 1000.5 } }, "invalid context"],
		["a non-integer context_length", { id: "m", context_length: "262144" }, "invalid context_length"],
		["a non-positive max_output_length", { id: "m", max_output_length: 0 }, "invalid max_output_length"],
		["a non-object modalities", { id: "m", modalities: "image" }, "invalid modalities"],
		["a non-array modalities.input", { id: "m", modalities: { input: "text" } }, "invalid modalities.input"],
		["a non-object capabilities", { id: "m", capabilities: "reasoning" }, "invalid capabilities"],
		["a non-object capabilities.reasoning", { id: "m", capabilities: { reasoning: "yes" } }, "invalid capabilities.reasoning"],
		["a non-string effort list", { id: "m", capabilities: { reasoning: { effort: ["high", 2] } } }, "invalid reasoning effort list"],
		["a non-boolean supported flag", { id: "m", capabilities: { reasoning: { supported: "yes" } } }, "non-boolean supported"],
		["a non-array supported_features", { id: "m", supported_features: "reasoning" }, "invalid supported_features"],
		["a string per-million price", { id: "m", cost: { text: { input: { price: "0.15" } } } }, "invalid cost.text.input.price"],
		["a negative per-million price", { id: "m", cost: { text: { output: { price: -1 } } } }, "invalid cost.text.output.price"],
		["a non-object cost", { id: "m", cost: "free" }, "invalid cost"],
		["a non-string name", { id: "m", name: 7 }, "non-string name"],
	];
	for (const [label, entry, problem] of cases) {
		respondWith({ data: [entry] });
		await assertRejects(() => new ModelCatalog(ENTRY).models(networked()), problem, `an entry with ${label}`);
		assertEq(capture.persisted, undefined, label);
	}
});
