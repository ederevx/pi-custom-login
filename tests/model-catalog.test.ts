import { ModelCatalog } from "../src/model-catalog.ts";
import type { CatalogRefreshContext, ProviderEntry } from "../src/provider-config.ts";
import { assertEq, assertRejects, test } from "./harness.ts";

const ENTRY: ProviderEntry = { name: "Verboo", baseUrl: "https://code.verboo.ai/router/v1" };
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
			{ id: "glm-5.2", display_name: "GLM 5.2", context_window: 1000000, vision: true, reasoning: { effort_levels: ["high"] } },
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
			maxTokens: 16384,
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
	assertEq(capture.persisted?.models.length, 2);
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
