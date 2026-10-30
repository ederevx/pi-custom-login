import { spawnSync } from "node:child_process";

import { ModelCatalog } from "../src/model-catalog.ts";
import { CONTEXT_WINDOW_VARIABLE, MAX_TOKENS_VARIABLE, type CatalogRefreshContext, type ProviderEntry } from "../src/provider-config.ts";
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
