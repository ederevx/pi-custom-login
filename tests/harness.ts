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

class TestRegistry {
	private readonly cases: Array<{ name: string; fn: TestFn }> = [];
	private passed = 0;
	private readonly failures: string[] = [];

	register(name: string, fn: TestFn): void {
		this.cases.push({ name, fn });
	}

	async runAll(): Promise<void> {
		for (const testCase of this.cases) {
			const started = Date.now();
			try {
				await testCase.fn();
				this.passed += 1;
				console.log(`  ok   ${testCase.name} (${Date.now() - started}ms)`);
			} catch (error) {
				this.failures.push(testCase.name);
				console.error(`  FAIL ${testCase.name}`);
				console.error(`       ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			}
		}
		console.log(`\n${this.passed}/${this.cases.length} passed`);
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
	readonly notifications: Array<{ message: string; type?: string }> = [];
	private readonly answers: Array<string | undefined>;

	readonly ui = {
		notify: (message: string, type?: "info" | "warning" | "error"): void => {
			this.notifications.push({ message, type });
		},
		input: async (): Promise<string | undefined> => this.answers.shift(),
	};

	constructor(answers: Array<string | undefined> = []) {
		this.answers = [...answers];
	}

	get lastMessage(): string {
		return this.notifications.at(-1)?.message ?? "";
	}
}
