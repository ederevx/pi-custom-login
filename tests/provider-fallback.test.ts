import { FakeClock, assert, assertEq, test } from "./harness.ts";
import { ProviderFallback, type FallbackRegistry } from "../src/provider-fallback.ts";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";

function model(provider: string, id: string, overrides: Record<string, unknown> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.com/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		reasoning: false,
		...overrides,
	} as Model<Api>;
}

const SETTINGS = { model: { provider: "other", id: "big" }, timeoutMs: 5000 };
const CONTEXT = { messages: [] } as unknown as TranscriptContext;

/** Lets the background forwarding task drain everything pushed so far. */
function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

interface Controlled {
	stream: ReturnType<typeof createAssistantMessageEventStream>;
	push: (event: never) => void;
	end: () => void;
}

function harness(registryOverrides: Partial<FallbackRegistry> = {}) {
	const clock = new FakeClock();
	const primary: Array<{ provider: string; id: string; options?: SimpleStreamOptions }> = [];
	const dispatched: Array<{ provider: string; id: string; options?: SimpleStreamOptions }> = [];
	const controlled: Controlled[] = [];
	const stream = new ProviderFallback(clock, (target, _context, options) => {
		primary.push({ provider: target.provider, id: target.id, options });
		const inner = createAssistantMessageEventStream();
		controlled.push({
			stream: inner,
			push: (event: never) => inner.push(event),
			end: () => inner.end(),
		});
		return inner;
	});
	const registry: FallbackRegistry = {
		find: (provider, id) => (provider === "other" && id === "big" ? model("other", "big", { maxTokens: 8000 }) : undefined),
		streamSimple: (target, _context, options) => {
			dispatched.push({ provider: target.provider, id: target.id, options });
			const inner = createAssistantMessageEventStream();
			controlled.push({
				stream: inner,
				push: (event: never) => inner.push(event),
				end: () => inner.end(),
			});
			return inner;
		},
		...registryOverrides,
	};
	stream.bindRegistry(registry);
	return { clock, primary, dispatched, controlled, stream };
}

function startEvent(target: { provider: string; id: string }): never {
	return { type: "start", message: { role: "assistant", provider: target.provider, api: "openai-completions", model: target.id } } as never;
}

function textEvent(target: { provider: string; id: string }): never {
	return { type: "text_start", contentIndex: 0, partial: { role: "assistant", provider: target.provider, api: "openai-completions", model: target.id, content: [], stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() } } as never;
}

function doneEvent(target: { provider: string; id: string }): never {
	return { type: "done", reason: "stop", message: { role: "assistant", provider: target.provider, api: "openai-completions", model: target.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", content: [], timestamp: Date.now() } } as never;
}

test("a start event alone does not cancel the deadline; first content commits the primary", async () => {
	const { clock, primary, controlled, stream } = harness();
	const outer = stream.stream(model("verboo", "m1"), CONTEXT, undefined, SETTINGS);
	const outcome = outer.result();
	controlled[0].push(startEvent({ provider: "verboo", id: "m1" }));
	await settle();
	controlled[0].push(textEvent({ provider: "verboo", id: "m1" }));
	await settle();
	controlled[0].push(doneEvent({ provider: "verboo", id: "m1" }));
	controlled[0].end();
	await settle();
	clock.advance(10000);
	const message = await outcome;
	assertEq(message.provider, "verboo");
	assertEq(primary.length, 1);
});

test("the deadline aborts the primary and dispatches the fallback once", async () => {
	const { clock, primary, dispatched, controlled, stream } = harness();
	const outer = stream.stream(model("verboo", "m1"), CONTEXT, { apiKey: "primary-secret", headers: { "x-a": "1" }, env: { K: "v" }, maxTokens: 12000 }, SETTINGS);
	const outcome = outer.result();
	await Promise.resolve();
	clock.advance(5000);
	await Promise.resolve();
	await Promise.resolve();
	assertEq(primary.length, 1);
	assertEq(dispatched.map((entry) => `${entry.provider}/${entry.id}`), ["other/big"]);
	assertEq(dispatched[0].options?.apiKey, undefined);
	assertEq(dispatched[0].options?.headers, undefined);
	assertEq(dispatched[0].options?.env, undefined);
	assertEq(dispatched[0].options?.maxTokens, 8000);
	controlled[1].push(doneEvent({ provider: "other", id: "big" }));
	controlled[1].end();
	const message = await outcome;
	assertEq(message.provider, "other");
});

test("late primary content after the timeout is suppressed", async () => {
	const { clock, dispatched, controlled, stream } = harness();
	const outer = stream.stream(model("verboo", "m1"), CONTEXT, undefined, SETTINGS);
	const outcome = outer.result();
	await Promise.resolve();
	clock.advance(5000);
	await Promise.resolve();
	await Promise.resolve();
	controlled[1].push(doneEvent({ provider: "other", id: "big" }));
	controlled[1].end();
	controlled[0].push(textEvent({ provider: "verboo", id: "m1" }));
	controlled[0].push(doneEvent({ provider: "verboo", id: "m1" }));
	const message = await outcome;
	assertEq(message.provider, "other");
	assertEq(dispatched.length, 1);
});

test("an early error does not fall back", async () => {
	const { clock, dispatched, controlled, stream } = harness();
	const outer = stream.stream(model("verboo", "m1"), CONTEXT, undefined, SETTINGS);
	const outcome = outer.result();
	await Promise.resolve();
	controlled[0].push({
		type: "error",
		reason: "error",
		error: { role: "assistant", provider: "verboo", api: "openai-completions", model: "m1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "HTTP 500", content: [], timestamp: Date.now() },
	} as never);
	controlled[0].end();
	const error = await outcome;
	assertEq(error.stopReason, "error");
	assertEq(error.errorMessage, "HTTP 500");
	clock.advance(10000);
	assertEq(dispatched.length, 0);
});

test("caller abort before dispatch yields an aborted result", async () => {
	const { primary, dispatched, stream } = harness();
	const controller = new AbortController();
	controller.abort();
	const outer = stream.stream(model("verboo", "m1"), CONTEXT, { signal: controller.signal }, SETTINGS);
	const error = await outer.result();
	assertEq(error.stopReason, "aborted");
	assertEq(primary.length, 0);
	assertEq(dispatched.length, 0);
});

test("a target without a registry entry ends in a clear terminal error", async () => {
	const { clock, dispatched, stream } = harness({
		find: () => undefined,
	});
	const outer = stream.stream(model("verboo", "m1"), CONTEXT, undefined, SETTINGS);
	const outcome = outer.result();
	await Promise.resolve();
	clock.advance(5000);
	await Promise.resolve();
	const error = await outcome;
	assertEq(error.stopReason, "error");
	assertEq(error.errorMessage?.includes("fallback target unavailable"), true);
	assertEq(dispatched.length, 0);
});

test("settings validation accepts only complete, in-range configurations", async () => {
	const { ProviderSettings } = await import("../src/provider-settings.ts");
	assertEq(ProviderSettings.normalize(undefined), undefined);
	assertEq(ProviderSettings.normalize({ model: { provider: "a", id: "b" } }), undefined);
	assertEq(ProviderSettings.normalize({ model: { provider: "a", id: "b" }, timeoutMs: 0 }), undefined);
	assertEq(ProviderSettings.normalize({ model: { provider: "", id: "b" }, timeoutMs: 10 }), undefined);
	assertEq(
		JSON.stringify(ProviderSettings.normalize({ model: { provider: "a", id: "b" }, timeoutMs: 10 })),
		'{"model":{"provider":"a","id":"b"},"timeoutMs":10}',
	);
});

test("a registered provider carries no stream hook unless a fallback is configured", async () => {
	const { ProviderRegistry } = await import("../src/provider-registry.ts");
	const { FakePi } = await import("./harness.ts");
	const pi = new FakePi();
	const registry = new ProviderRegistry(pi.extension());
	registry.registerAll({ plain: { baseUrl: "https://plain.example/v1" } });
	assertEq(pi.providers.get("plain")?.streamSimple, undefined);
	assertEq(pi.providers.get("plain")?.baseUrl, "https://plain.example/v1");
	registry.registerAll({ managed: { baseUrl: "https://m.example/v1", fallback: { model: { provider: "other", id: "big" }, timeoutMs: 5000 } } });
	assertEq(typeof pi.providers.get("managed")?.streamSimple, "function");
});

test("the default transport rejects a non-completions primary instead of crashing later", async () => {
	const { ProviderFallback } = await import("../src/provider-fallback.ts");
	const fallback = new ProviderFallback();
	const outer = fallback.stream(model("verboo", "m1", { api: "anthropic-messages" }), CONTEXT, undefined, SETTINGS);
	const error = await outer.result();
	assertEq(error.stopReason, "error");
	assertEq(error.errorMessage?.includes("Unsupported primary API"), true);
});

test("a configured fallback provider cannot chain to a third model", async () => {
	const clock = new FakeClock();
	const dispatches: string[] = [];
	const transports: string[] = [];
	const wrapper = new ProviderFallback(clock, ((target: never) => {
		transports.push((target as unknown as { provider: string }).provider);
		return createAssistantMessageEventStream();
	}) as never);
	let active = "";
	wrapper.bindRegistry({
		find: (provider, id) => model(provider, id),
		streamSimple: (target, context, options) => {
			dispatches.push(`${target.provider}/${target.id}`);
			return wrapper.stream(target as never, context, options, { model: { provider: "third", id: "far" }, timeoutMs: 5000 });
		},
	} as never);
	const settings = { model: { provider: "other", id: "big" }, timeoutMs: 5000 };
	void active;
	const outer = wrapper.stream(model("verboo", "m1"), CONTEXT, undefined, settings);
	const outcome = outer.result();
	await settle();
	clock.advance(5000);
	await settle();
	await settle();
	assertEq(dispatches, ["other/big"]);
	clock.advance(5000);
	await settle();
	const error = await outcome;
	assertEq(error.stopReason, "error");
	assertEq(error.errorMessage?.includes("another fallback is not permitted"), true);
	assertEq(dispatches.length, 1);
});

test("an early done before content commits without fallover", async () => {
	const { clock, controlled, dispatched, stream } = harness();
	const outer = stream.stream(model("verboo", "m1"), CONTEXT, undefined, SETTINGS);
	const outcome = outer.result();
	controlled[0].push(doneEvent({ provider: "verboo", id: "m1" }));
	controlled[0].end();
	await settle();
	clock.advance(10000);
	const message = await outcome;
	assertEq(message.provider, "verboo");
	assertEq(dispatched.length, 0);
});

test("a stream ending without a terminal event becomes a terminal error", async () => {
	const { clock, controlled, stream } = harness();
	const outer = stream.stream(model("verboo", "m1"), CONTEXT, undefined, SETTINGS);
	const outcome = outer.result();
	controlled[0].end();
	await settle();
	clock.advance(10000);
	const error = await outcome;
	assertEq(error.stopReason, "error");
	assertEq(error.errorMessage?.includes("without a terminal event"), true);
});

test("concurrent requests keep independent deadlines", async () => {
	const { clock, controlled, dispatched, stream } = harness();
	const first = stream.stream(model("verboo", "a"), CONTEXT, undefined, SETTINGS).result();
	const second = stream.stream(model("verboo", "b"), CONTEXT, undefined, SETTINGS).result();
	controlled[0].push(textEvent({ provider: "verboo", id: "a" }));
	await settle();
	controlled[0].push(doneEvent({ provider: "verboo", id: "a" }));
	controlled[0].end();
	clock.advance(5000);
	await settle();
	await settle();
	const firstMessage = await first;
	assertEq(firstMessage.provider, "verboo");
	assertEq(dispatched.length, 1);
	controlled[2].push(doneEvent({ provider: "other", id: "big" }));
	controlled[2].end();
	const secondMessage = await second;
	assertEq(secondMessage.provider, "other");
});
