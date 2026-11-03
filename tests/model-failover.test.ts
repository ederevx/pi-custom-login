import { createAssistantMessageEventStream, registerApiProvider } from "@earendil-works/pi-ai/compat";

import { FallbackChain } from "../src/fallback-chain.ts";
import { ModelFailover } from "../src/model-failover.ts";
import { ProviderRegistry } from "../src/provider-registry.ts";
import { ProviderStore } from "../src/provider-store.ts";
import { FakePi, assertEq, scratchDir, test } from "./harness.ts";

const API = "test-chat";
const BASE_URL = "https://code.verboo.ai/router/v1";

/** The next scripts of the registered test API, one per primary attempt. */
const primary: unknown[][] = [];
const produced: unknown[] = [];

const streamSimple = (): unknown => {
	const attempt = emit(primary.shift() ?? []);
	produced.push(attempt);
	return attempt;
};

registerApiProvider({ api: API, stream: streamSimple, streamSimple }, "tests");

function emit(events: unknown[]): unknown {
	const stream = createAssistantMessageEventStream();
	for (const event of events) {
		(stream as { push: (value: unknown) => void }).push(event);
	}
	stream.end();
	return stream;
}

function model(provider: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		name: id,
		provider,
		api: API,
		baseUrl: BASE_URL,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 10000,
		maxTokens: 1000,
		...extra,
	};
}

function assistant(provider: string, id: string, stopReason: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		role: "assistant",
		content: [],
		api: API,
		provider,
		model: id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: 0,
		...extra,
	};
}

const start = (provider: string, id: string): unknown => ({ type: "start", partial: assistant(provider, id, "pending") });
const text = (provider: string, id: string): unknown => ({ type: "text_delta", contentIndex: 0, delta: "hi", partial: assistant(provider, id, "pending") });
const done = (provider: string, id: string, cost = 0): unknown => ({
	type: "done",
	reason: "stop",
	message: assistant(provider, id, "stop", {
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
	}),
});
const failed = (provider: string, id: string, errorMessage: string): unknown => ({
	type: "error",
	reason: "error",
	error: assistant(provider, id, "error", { errorMessage }),
});

/** The session context pi hands to a session_start handler. */
class FakeSessionContext {
	readonly notifications: Array<{ message: string; type?: string }> = [];
	readonly served: Array<{ model: Record<string, unknown>; options?: Record<string, unknown> }> = [];
	readonly registry = new Map<string, Record<string, unknown>>();
	readonly unauthenticated = new Set<string>();
	readonly scripts: unknown[][] = [];

	readonly ui = {
		notify: (message: string, type?: "info" | "warning" | "error"): void => {
			this.notifications.push({ message, type });
		},
	};

	readonly modelRegistry = {
		find: (provider: string, id: string): unknown => this.registry.get(`${provider}/${id}`),
		hasConfiguredAuth: (target: { provider: string; id: string }): boolean => !this.unauthenticated.has(`${target.provider}/${target.id}`),
		streamSimple: (target: Record<string, unknown>, _context: unknown, options?: Record<string, unknown>): unknown => {
			this.served.push({ model: target, options });
			return emit(this.scripts.shift() ?? []);
		},
	};

	get lastMessage(): string {
		return this.notifications.at(-1)?.message ?? "";
	}
}

async function forward(name: string, entry: Record<string, unknown>): Promise<{ ctx: FakeSessionContext; failover: ModelFailover }> {
	const pi = new FakePi();
	const store = new ProviderStore(`${scratchDir()}/${name}`);
	store.add("verboo", { baseUrl: BASE_URL, ...entry });
	const failover = new ModelFailover(pi.extension(), store);
	const ctx = new FakeSessionContext();
	await pi.sessionStart(ctx);
	return { ctx, failover };
}

async function collect(stream: unknown): Promise<Array<Record<string, unknown>>> {
	const events: Array<Record<string, unknown>> = [];
	for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
		events.push(event);
	}
	return events;
}

function reset(): void {
	primary.length = 0;
	produced.length = 0;
}

test("a model without a fallback gets the provider's own stream", () => {
	reset();
	primary.push([start("verboo", "a"), done("verboo", "a")]);
	const pi = new FakePi();
	const store = new ProviderStore(`${scratchDir()}/failover-plain`);
	store.add("verboo", { baseUrl: BASE_URL });
	const failover = new ModelFailover(pi.extension(), store);
	const stream = failover.stream(model("verboo", "a") as never, {} as never, {});
	assertEq(stream, produced[0], "the attempt is returned unchanged");
});

test("an attempt that fails before content is served by the fallback", async () => {
	reset();
	primary.push([start("verboo", "a"), failed("verboo", "a", "boom")]);
	const { ctx, failover } = await forward("failover-serves", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	ctx.registry.set("other/b", model("other", "b"));
	ctx.scripts.push([start("other", "b"), done("other", "b", 0.5)]);
	const events = await collect(failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(JSON.stringify(events.map((event) => event.type)), JSON.stringify(["start", "done"]));
	assertEq((events[1].message as { provider: string; model: string }).provider, "other");
	assertEq(ctx.notifications.length, 1);
	assertEq(ctx.notifications[0].type, "warning");
	assertEq(ctx.lastMessage.includes("other/b"), true);
	assertEq(ctx.lastMessage.includes("$0.500000"), true);
});

test("the fallback gets no credentials of the failed provider and a capped output budget", async () => {
	reset();
	primary.push([start("verboo", "a"), failed("verboo", "a", "boom")]);
	const { ctx, failover } = await forward("failover-options", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	ctx.registry.set("other/b", model("other", "b", { maxTokens: 100 }));
	ctx.scripts.push([start("other", "b"), done("other", "b")]);
	const options = { apiKey: "k", headers: { "X-A": "1" }, env: { A: "1" }, maxTokens: 500, reasoning: "high" };
	await collect(failover.stream(model("verboo", "a") as never, {} as never, options as never));
	assertEq(JSON.stringify(ctx.served[0].options), JSON.stringify({ maxTokens: 100, reasoning: undefined }));
});

test("an error after content is never replayed on the fallback", async () => {
	reset();
	primary.push([start("verboo", "a"), text("verboo", "a"), failed("verboo", "a", "boom")]);
	const { ctx, failover } = await forward("failover-partial", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	ctx.registry.set("other/b", model("other", "b"));
	const events = await collect(failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(JSON.stringify(events.map((event) => event.type)), JSON.stringify(["start", "text_delta", "error"]));
	assertEq(ctx.served.length, 0);
});

test("a cancel is not a provider failure", async () => {
	reset();
	primary.push([{ type: "error", reason: "aborted", error: assistant("verboo", "a", "aborted") }]);
	const { ctx, failover } = await forward("failover-abort", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	ctx.registry.set("other/b", model("other", "b"));
	const events = await collect(failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(JSON.stringify(events.map((event) => event.type)), JSON.stringify(["error"]));
	assertEq(ctx.served.length, 0);
});

test("an already aborted signal is not a provider failure", async () => {
	reset();
	primary.push([start("verboo", "a"), failed("verboo", "a", "boom")]);
	const { ctx, failover } = await forward("failover-signal", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	ctx.registry.set("other/b", model("other", "b"));
	const controller = new AbortController();
	controller.abort();
	await collect(failover.stream(model("verboo", "a") as never, {} as never, { signal: controller.signal }));
	assertEq(ctx.served.length, 0);
});

test("a context overflow is pi's to compact, not the fallback's", async () => {
	reset();
	primary.push([start("verboo", "a"), failed("verboo", "a", "prompt is too long: 213462 tokens > 200000 maximum")]);
	const { ctx, failover } = await forward("failover-overflow", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	ctx.registry.set("other/b", model("other", "b"));
	await collect(failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(ctx.served.length, 0);
});

test("a fallback that is missing or has no credentials reports why and keeps the error", async () => {
	reset();
	primary.push([start("verboo", "a"), failed("verboo", "a", "boom")]);
	const missing = await forward("failover-missing", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	const events = await collect(missing.failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(JSON.stringify(events.map((event) => event.type)), JSON.stringify(["error"]));
	assertEq(missing.ctx.lastMessage.includes("is not in the model list"), true);

	primary.push([start("verboo", "a"), failed("verboo", "a", "boom")]);
	const unauthenticated = await forward("failover-noauth", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	unauthenticated.ctx.registry.set("other/b", model("other", "b"));
	unauthenticated.ctx.unauthenticated.add("other/b");
	await collect(unauthenticated.failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(unauthenticated.ctx.served.length, 0);
	assertEq(unauthenticated.ctx.lastMessage.includes("has no credentials"), true);
});

test("a stored loop is refused instead of retried", async () => {
	reset();
	primary.push([start("verboo", "a"), failed("verboo", "a", "boom")]);
	const self = await forward("failover-self", { modelOverrides: { a: { fallback: { provider: "verboo", model: "a" } } } });
	self.ctx.registry.set("verboo/a", model("verboo", "a"));
	const events = await collect(self.failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(JSON.stringify(events.map((event) => event.type)), JSON.stringify(["error"]));
	assertEq(self.ctx.lastMessage.includes("returns to it"), true);
	assertEq(self.ctx.served.length, 0);
});

test("a failing fallback ends the stream with its own error", async () => {
	reset();
	primary.push([start("verboo", "a"), failed("verboo", "a", "boom")]);
	const { ctx, failover } = await forward("failover-broken", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	ctx.registry.set("other/b", model("other", "b"));
	ctx.scripts.push([start("other", "b"), failed("other", "b", "also broken")]);
	const events = await collect(failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(events.at(-1)?.type, "error");
	assertEq((events.at(-1)?.error as { errorMessage: string }).errorMessage, "also broken");
	assertEq(ctx.lastMessage.includes("boom"), true);
	assertEq(ctx.lastMessage.includes("also broken"), true);
});

test("a normal ending is forwarded untouched", async () => {
	reset();
	primary.push([start("verboo", "a"), done("verboo", "a")]);
	const { ctx, failover } = await forward("failover-done", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	ctx.registry.set("other/b", model("other", "b"));
	const events = await collect(failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(JSON.stringify(events.map((event) => event.type)), JSON.stringify(["start", "done"]));
	assertEq(ctx.served.length, 0);
});

test("without a bound session the original error passes through", async () => {
	reset();
	primary.push([start("verboo", "a"), failed("verboo", "a", "boom")]);
	const pi = new FakePi();
	const store = new ProviderStore(`${scratchDir()}/failover-unbound`);
	store.add("verboo", { baseUrl: BASE_URL, modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	const failover = new ModelFailover(pi.extension(), store);
	const events = await collect(failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(JSON.stringify(events.map((event) => event.type)), JSON.stringify(["error"]));
});

test("a cancelled fallback is reported as cancelled, never as having served", async () => {
	reset();
	primary.push([start("verboo", "a"), failed("verboo", "a", "boom")]);
	const { ctx, failover } = await forward("failover-cancelled", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	ctx.registry.set("other/b", model("other", "b"));
	ctx.scripts.push([start("other", "b"), { type: "error", reason: "aborted", error: assistant("other", "b", "aborted") }]);
	await collect(failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(ctx.lastMessage.includes("other/b was cancelled"), true);
	assertEq(ctx.lastMessage.includes("$"), false);
});

test("an attempt that stops without a final event still ends the stream", async () => {
	reset();
	primary.push([start("verboo", "a")]);
	const plain = new FakePi();
	const store = new ProviderStore(`${scratchDir()}/failover-silent-plain`);
	store.add("verboo", { baseUrl: BASE_URL });
	const forwarded = await collect(new ModelFailover(plain.extension(), store).stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(JSON.stringify(forwarded.map((event) => event.type)), JSON.stringify(["start"]));

	reset();
	primary.push([start("verboo", "a"), failed("verboo", "a", "boom")]);
	const { ctx, failover } = await forward("failover-silent", { modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } });
	ctx.registry.set("other/b", model("other", "b"));
	ctx.scripts.push([start("other", "b")]);
	const events = await collect(failover.stream(model("verboo", "a") as never, {} as never, {}));
	assertEq(JSON.stringify(events.map((event) => event.type)), JSON.stringify(["start"]));
});

test("the chain follows stored fallbacks and ends at a model without one", () => {
	const chain = new FallbackChain({
		verboo: { baseUrl: BASE_URL, modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } },
		other: { baseUrl: "https://other.test/v1", modelOverrides: { b: { fallback: { provider: "builtin", model: "c" } } } },
	});
	assertEq(JSON.stringify(chain.next("verboo", "a")), JSON.stringify({ provider: "other", model: "b" }));
	assertEq(chain.loops("verboo", "a"), false);
	assertEq(chain.next("builtin", "c"), undefined);
	const looped = new FallbackChain({
		verboo: { baseUrl: BASE_URL, modelOverrides: { a: { fallback: { provider: "other", model: "b" } } } },
		other: { baseUrl: "https://other.test/v1", modelOverrides: { b: { fallback: { provider: "verboo", model: "a" } } } },
	});
	assertEq(looped.loops("verboo", "a"), true);
});

test("the registered provider carries the API and the failover stream", () => {
	const pi = new FakePi();
	const store = new ProviderStore(`${scratchDir()}/failover-registry`);
	store.add("verboo", { baseUrl: BASE_URL });
	new ProviderRegistry(pi.extension(), new ModelFailover(pi.extension(), store)).registerAll(store.all());
	assertEq(pi.providers.get("verboo")?.api, "openai-completions");
	assertEq(typeof pi.providers.get("verboo")?.streamSimple, "function");
});
