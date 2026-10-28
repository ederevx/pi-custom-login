import { ModelCatalog } from "../src/model-catalog.ts";
import type { CatalogRefreshContext, ProviderEntry } from "../src/provider-config.ts";
import { assertEq, assertRejects, test } from "./harness.ts";

const ENTRY: ProviderEntry = { name: "Verboo", baseUrl: "https://code.verboo.ai/router/v1", apiKey: "$VERBOO_TEST_KEY" };
const SIGNAL = new AbortController().signal;

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
	capture.requests = 0;
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

test("a catalog maps the fields pi needs", async () => {
	reset();
	respondWith({
		data: [
			{ id: "glm-5.2", display_name: "GLM 5.2", context_window: 1000000, vision: true, reasoning: { effort_levels: ["high"] } },
			{ id: "qwen3.8-27b", context_window: 262144 },
		],
	});
	const models = await new ModelCatalog(ENTRY).models(context({ credential: { type: "api_key", key: "k" } }));
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

test("a stored key is used before the environment", async () => {
	reset();
	process.env.VERBOO_TEST_KEY = "from-env";
	respondWith({ data: [{ id: "model" }] });
	await new ModelCatalog(ENTRY).models(context({ credential: { type: "api_key", key: "from-login" } }));
	assertEq(capture.headers?.Authorization, "Bearer from-login");
	delete process.env.VERBOO_TEST_KEY;
});

test("an environment reference supplies the key when nothing is stored", async () => {
	reset();
	process.env.VERBOO_TEST_KEY = "from-env";
	respondWith({ data: [{ id: "model" }] });
	await new ModelCatalog(ENTRY).models(context());
	assertEq(capture.headers?.Authorization, "Bearer from-env");
	delete process.env.VERBOO_TEST_KEY;
});

test("a literal key is accepted as written", async () => {
	reset();
	respondWith({ data: [{ id: "model" }] });
	await new ModelCatalog({ baseUrl: "http://127.0.0.1:8080/v1", apiKey: "local" }).models(context());
	assertEq(capture.headers?.Authorization, "Bearer local");
});

test("offline keeps the stored list without a request", async () => {
	reset();
	const stored = [{ id: "stored" }] as never;
	const models = await new ModelCatalog(ENTRY).models(context({ stored: { models: stored }, allowNetwork: false }));
	assertEq(models.length, 1);
	assertEq(capture.requests, 0);
});

test("no key returns what was stored and asks no server", async () => {
	reset();
	const models = await new ModelCatalog(ENTRY).models(context());
	assertEq(models.length, 0);
	assertEq(capture.requests, 0);
});

test("a failed catalog rejects and persists nothing", async () => {
	reset();
	respondWith({}, 401);
	await assertRejects(() => new ModelCatalog(ENTRY).models(context({ credential: { type: "api_key", key: "k" } })), "HTTP 401");
	assertEq(capture.persisted, undefined);
});

test("a body without a model list rejects", async () => {
	reset();
	respondWith({ object: "list" });
	await assertRejects(() => new ModelCatalog(ENTRY).models(context({ credential: { type: "api_key", key: "k" } })), "no model list");
});
