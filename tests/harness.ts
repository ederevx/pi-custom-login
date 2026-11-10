/**
 * pi-custom-login — minimal zero-dependency test harness.
 *
 * Owns the registry, the assertions, the scratch root (under ~/tmp), and the
 * fake pi surface: providers, commands, and the command context.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "@earendil-works/pi-coding-agent";

export type TestFn = () => void | Promise<void>;

interface NonPass {
	name: string;
	reason: string;
}

/**
 * A test's own declared non-pass: the property it asserts cannot be exercised
 * on this host. Thrown at runtime, so a capability probe reports the test it
 * abandons instead of passing or failing it by accident.
 */
export class UnsupportedOutcome extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "UnsupportedOutcome";
	}
}

class TestRegistry {
	private readonly cases: Array<{ name: string; fn: TestFn }> = [];
	private readonly nonPasses: NonPass[] = [];
	private passed = 0;
	private readonly failures: string[] = [];

	register(name: string, fn: TestFn): void {
		this.cases.push({ name, fn });
	}

	/** Record a property this host cannot exercise. Never counts as a pass. */
	unsupported(name: string, reason: string): void {
		this.nonPasses.push({ name, reason });
	}

	async runAll(): Promise<void> {
		for (const testCase of this.cases) {
			const started = Date.now();
			try {
				await testCase.fn();
				this.passed += 1;
				console.log(`  ok   ${testCase.name} (${Date.now() - started}ms)`);
			} catch (error) {
				if (error instanceof UnsupportedOutcome) {
					this.unsupported(testCase.name, error.reason);
					console.log(`  n/a  ${testCase.name} — ${error.reason}`);
					continue;
				}
				this.failures.push(testCase.name);
				console.error(`  FAIL ${testCase.name}`);
				console.error(`       ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			}
		}
		console.log(`\n${this.passed}/${this.cases.length} passed`);
		if (this.nonPasses.length > 0) {
			console.log(`${this.nonPasses.length} not exercised on this host:`);
			for (const nonPass of this.nonPasses) console.log(`  n/a  ${nonPass.name} — ${nonPass.reason}`);
		}
		if (this.failures.length > 0) console.error(`Failed: ${this.failures.join(", ")}`);
	}

	get failed(): number {
		return this.failures.length;
	}
}

export const registry = new TestRegistry();

export function test(name: string, fn: TestFn): void {
	registry.register(name, fn);
}

/** Register a named non-pass for a property this host cannot exercise. */
export function testUnsupported(name: string, reason: string): void {
	registry.unsupported(name, reason);
}

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export function assertEq<T>(actual: T, expected: T, message?: string): void {
	if (actual !== expected) {
		throw new Error(`${message ?? "assertEq"} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

export async function assertRejects(fn: () => Promise<unknown>, expected: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes(expected)) throw new Error(`expected ${expected}, got ${message}`);
		return;
	}
	throw new Error("expected a rejection");
}

export function assertThrows(fn: () => unknown, expected: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes(expected)) throw new Error(`expected ${expected}, got ${message}`);
		return;
	}
	throw new Error("expected a throw");
}

const nativeFetch = globalThis.fetch;

let scratchRoot: string | undefined;

export function scratchDir(): string {
	if (scratchRoot === undefined) scratchRoot = mkdtempSync(join(homedir(), "tmp", "pi-custom-login-tests-"));
	return scratchRoot;
}

export function cleanupScratch(): void {
	if (scratchRoot !== undefined) {
		rmSync(scratchRoot, { recursive: true, force: true });
		scratchRoot = undefined;
	}
	globalThis.fetch = nativeFetch;
}

/** A minimal stand-in for pi's ExtensionAPI. */
export class FakePi {
	readonly providers = new Map<string, ProviderConfig>();
	readonly commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	readonly unregistered: string[] = [];
	private readonly handlers = new Map<string, Array<(event: { type: string }, ctx: unknown) => void>>();

	on(event: string, handler: (event: { type: string }, ctx: unknown) => void): () => void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => {};
	}

	/** Delivers the event pi emits once its session context is bound. */
	async sessionStart(ctx: unknown): Promise<void> {
		await this.emit("session_start", ctx);
	}

	/** Delivers any other lifecycle event pi emits, in the order it emits it. */
	async emit(event: string, ctx?: unknown): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler({ type: event }, ctx);
		}
	}

	registerProvider(id: string, config: ProviderConfig): void {
		this.providers.set(id, config);
	}

	unregisterProvider(id: string): void {
		this.unregistered.push(id);
		this.providers.delete(id);
	}

	registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }): void {
		this.commands.set(name, options);
	}

	async command(name: string, args: string, ctx: FakeCommandContext): Promise<void> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`unknown command: ${name}`);
		await command.handler(args, ctx as unknown as ExtensionCommandContext);
	}

	extension(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}
}

/** A minimal stand-in for pi's ExtensionCommandContext. */
export class FakeCommandContext {
	readonly mode = "rpc";
	readonly notifications: Array<{ message: string; type?: string }> = [];
	readonly offers: string[][] = [];
	readonly titles: string[] = [];
	readonly unavailable = new Set<string>();
	readonly prompts: string[] = [];
	private readonly answers: Array<string | undefined>;
	private readonly selections: Array<string | undefined>;
	private readonly knownModels: ReadonlyMap<string, Array<Record<string, unknown>>>;

	readonly ui = {
		notify: (message: string, type?: "info" | "warning" | "error"): void => {
			this.notifications.push({ message, type });
		},
		input: async (title: string): Promise<string | undefined> => {
			this.prompts.push(title);
			return this.answers.shift();
		},
		select: async (title: string, options: readonly string[]): Promise<string | undefined> => {
			this.titles.push(title);
			this.offers.push([...options]);
			const choice = this.selections.shift();
			return choice !== undefined && options.includes(choice) ? choice : undefined;
		},
	};

	readonly modelRegistry = {
		getModelsOfType: (_type: string, providerId?: string): unknown[] =>
			(providerId === undefined ? [] : [...(this.knownModels.get(providerId) ?? [])]).map((model) => ({ provider: providerId, ...model })),
		getModelOfType: (_type: string, providerId: string, modelId: string): unknown =>
			this.knownModels.get(providerId)?.find((model) => model.id === modelId),
		getAvailableOfType: async (_type: string): Promise<Array<{ provider: string }>> =>
			[...this.knownModels]
				.filter(([provider]) => !this.unavailable.has(provider))
				.flatMap(([provider, models]) => models.map(() => ({ provider }))),
		getProviderDisplayName: (providerId: string): string => providerId,
	};

	constructor(
		answers: Array<string | undefined> = [],
		selections: Array<string | undefined> = [],
		knownModels: Record<string, Array<Record<string, unknown>>> = {},
	) {
		this.answers = [...answers];
		this.selections = [...selections];
		this.knownModels = new Map(Object.entries(knownModels));
	}

	get lastMessage(): string {
		return this.notifications.at(-1)?.message ?? "";
	}
}
