import { assertEq, test } from "./harness.ts";
import { MAX_TIMEOUT_MS, type ProviderFallbackConfig } from "../src/provider-config.ts";
import { ProviderSettings, type CatalogEntry } from "../src/provider-settings.ts";
import { SettingsScreen, type SettingsDraft } from "../src/settings-screen.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function entry(provider: string, id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
	return {
		provider,
		id,
		api: "openai-completions",
		contextWindow: 128000,
		input: ["text"],
		...overrides,
	};
}

test("a stored fallback needs a model and a valid whole-millisecond timeout", () => {
	assertEq(ProviderSettings.normalize(undefined), undefined);
	assertEq(ProviderSettings.normalize({ model: { provider: "a", id: "b" } }), undefined);
	assertEq(ProviderSettings.normalize({ model: { provider: "a", id: "b" }, timeoutMs: 0 }), undefined);
	assertEq(ProviderSettings.normalize({ model: { provider: "a", id: "b" }, timeoutMs: 1.5 }), undefined);
	assertEq(ProviderSettings.normalize({ model: { provider: "a", id: "b" }, timeoutMs: MAX_TIMEOUT_MS + 1 }), undefined);
	assertEq(ProviderSettings.normalize({ model: { provider: "", id: "b" }, timeoutMs: 10 }), undefined);
	assertEq(
		JSON.stringify(ProviderSettings.normalize({ model: { provider: "a", id: "b" }, timeoutMs: 10 })),
		'{"model":{"provider":"a","id":"b"},"timeoutMs":10}',
	);
});

test("an entered timeout must be a whole number of milliseconds", () => {
	assertEq(ProviderSettings.parseTimeout("30000"), 30000);
	assertEq(ProviderSettings.parseTimeout(" 4500 "), 4500);
	assertEq(ProviderSettings.parseTimeout("0"), undefined);
	assertEq(ProviderSettings.parseTimeout("-5"), undefined);
	assertEq(ProviderSettings.parseTimeout("1.5"), undefined);
	assertEq(ProviderSettings.parseTimeout("soon"), undefined);
});

test("candidates are physical chat models of other providers that fit every source model", () => {
	const catalog = [
		entry("verboo", "big", { contextWindow: 1000 }),
		entry("verboo", "small", { contextWindow: 500, input: ["text"] }),
		entry("other", "fits", { contextWindow: 1000 }),
		entry("other", "too-small", { contextWindow: 600 }),
		entry("other", "virtual", { api: "pi-virtual" }),
		entry("other", "image", { type: "image" }),
		entry("verboo", "own", { contextWindow: 900 }),
	];
	assertEq(
		JSON.stringify(ProviderSettings.candidates("verboo", catalog)),
		'[{"provider":"other","id":"fits"}]',
	);
});

test("a target must accept every input modality of its source", () => {
	const catalog = [
		entry("verboo", "vision", { input: ["text", "image"] }),
		entry("other", "text-only"),
		entry("other", "sees", { input: ["text", "image"] }),
	];
	assertEq(JSON.stringify(ProviderSettings.candidates("verboo", catalog)), '[{"provider":"other","id":"sees"}]');
});

const DRAFT: SettingsDraft = { model: { provider: "other", id: "fits" }, timeoutMs: 30000 };

test("the editor rows show the current fallback and timeout", () => {
	const rows = SettingsScreen.items(DRAFT, undefined);
	assertEq(rows[0].currentValue, "other/fits");
	assertEq(rows[1].currentValue, "30000 ms");
	assertEq(rows[1].label, "Response-start timeout");
});

test("a disabled fallback shows Disabled while keeping the timeout row", () => {
	const rows = SettingsScreen.items({ model: null, timeoutMs: 12000 }, undefined);
	assertEq(rows[0].currentValue, "Disabled");
	assertEq(rows[1].currentValue, "12000 ms");
});

test("a saved model the catalog no longer offers stays visible", () => {
	const stored: ProviderFallbackConfig = { model: { provider: "gone", id: "m" }, timeoutMs: 5000 };
	const unavailable = SettingsScreen.unavailable(stored, [{ provider: "other", id: "fits" }]);
	assertEq(JSON.stringify(unavailable), '{"provider":"gone","id":"m"}');
	assertEq(SettingsScreen.items({ model: stored.model, timeoutMs: 5000 }, unavailable)[0].currentValue, "gone/m (saved; unavailable)");
});

test("an offered model is not reported as unavailable", () => {
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 5000 };
	assertEq(SettingsScreen.unavailable(stored, [{ provider: "other", id: "fits" }]), undefined);
});

/** A TUI context whose custom() builds the component; the result resolves when the screen calls done. */
function screenContext() {
	let component: { render(width: number): string[]; handleInput(data: string): void; focused: boolean } | undefined;
	const keybindings = {
		matches: (data: string, id: string): boolean => {
			const map: Record<string, string[]> = {
				"tui.select.up": ["\u001b[A"],
				"tui.select.down": ["\u001b[B"],
				"tui.select.confirm": ["\r"],
				"tui.select.cancel": ["\u001b"],
			};
			if (id === "ctrl+s") {
				return data === "\u0013" || data === "\u001b[115;5u";
			}
			return (map[id] ?? []).includes(data);
		},
	};
	const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
	let settle: (value: unknown) => void = () => {};
	const ctx = {
		mode: "tui",
		ui: {
			custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value?: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void; focused: boolean }) => {
				const opened = new Promise<unknown>((resolve) => {
					settle = resolve;
				});
				component = factory({ requestRender: () => {} }, theme, keybindings, (value?: unknown) => settle(value));
				return opened;
			},
			notify: () => {},
		},
	} as unknown as ExtensionCommandContext;
	return { component: () => component!, ctx };
}

test("saving the screen returns the edited configuration", async () => {
	const screen = screenContext();
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 5000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx);
	await tick();
	const rendered = screen.component().render(80).join("\n");
	assertEq(rendered.includes("Fallback for verboo"), true);
	assertEq(rendered.includes("other/fits"), true);
	assertEq(rendered.includes("5000 ms"), true);
	screen.component().handleInput("\u0013");
	assertEq(JSON.stringify(await opened), '{"model":{"provider":"other","id":"fits"},"timeoutMs":5000}');
});

test("cancelling the screen resolves without a configuration", async () => {
	const screen = screenContext();
	const opened = SettingsScreen.open("verboo", undefined, [], screen.ctx);
	await tick();
	screen.component().handleInput("\u001b");
	assertEq(await opened, undefined);
});

test("a disabled provider saves as null so the caller deletes the setting", async () => {
	const screen = screenContext();
	const opened = SettingsScreen.open("verboo", undefined, [{ provider: "other", id: "fits" }], screen.ctx);
	await tick();
	screen.component().handleInput("\u0013");
	assertEq(await opened, null);
});

test("the fallback submenu renders, searches inside provider/model, and selects with Enter", async () => {
	const screen = screenContext();
	const candidates = [
		{ provider: "other", id: "fits" },
		{ provider: "another", id: "wide" },
	];
	const opened = SettingsScreen.open("verboo", undefined, candidates, screen.ctx);
	await tick();
	screen.component().handleInput("\r");
	await tick();
	const menu = screen.component().render(80).join("\n");
	assertEq(menu.includes("Disabled"), true);
	assertEq(menu.includes("other/fits"), true);
	assertEq(menu.includes("another/wide"), true);
	screen.component().handleInput("w");
	screen.component().handleInput("i");
	screen.component().handleInput("d");
	await tick();
	assertEq(screen.component().render(80).join("\n").includes("another/wide"), true);
	screen.component().handleInput("\r");
	await tick();
	screen.component().handleInput("\u0013");
	assertEq(JSON.stringify(await opened), '{"model":{"provider":"another","id":"wide"},"timeoutMs":30000}');
});

test("arrow keys move inside the fallback list before confirming", async () => {
	const screen = screenContext();
	const candidates = [
		{ provider: "other", id: "fits" },
		{ provider: "another", id: "wide" },
	];
	const opened = SettingsScreen.open("verboo", undefined, candidates, screen.ctx);
	await tick();
	screen.component().handleInput("\r");
	await tick();
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\r");
	await tick();
	screen.component().handleInput("\u0013");
	assertEq(JSON.stringify(await opened), '{"model":{"provider":"another","id":"wide"},"timeoutMs":30000}');
});

test("focus reaches the active input and clearing it removes the cursor marker", async () => {
	const { CURSOR_MARKER } = await import("@earendil-works/pi-tui");
	const screen = screenContext();
	const opened = SettingsScreen.open("verboo", undefined, [{ provider: "other", id: "fits" }], screen.ctx);
	await tick();
	screen.component().focused = true;
	screen.component().handleInput("\r");
	await tick();
	assertEq(screen.component().render(80).join("\n").includes(CURSOR_MARKER), true);
	let settled = false;
	void opened.then(() => {
		settled = true;
	});
	screen.component().handleInput("\u0013");
	await tick();
	assertEq(settled, false);
	screen.component().focused = false;
	assertEq(screen.component().render(80).join("\n").includes(CURSOR_MARKER), false);
	screen.component().handleInput("\u001b");
	await tick();
	screen.component().handleInput("\u0013");
	await opened;
});

test("Kitty-encoded Ctrl+S saves as well as the legacy byte", async () => {
	const screen = screenContext();
	const opened = SettingsScreen.open("verboo", undefined, [], screen.ctx);
	await tick();
	screen.component().handleInput("\u001b[115;5u");
	assertEq(await opened, null);
});

test("escape inside the fallback submenu returns without changing the draft", async () => {
	const screen = screenContext();
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 7000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx);
	await tick();
	screen.component().handleInput("\r");
	await tick();
	screen.component().handleInput("\u001b");
	await tick();
	screen.component().handleInput("\u0013");
	assertEq(JSON.stringify(await opened), '{"model":{"provider":"other","id":"fits"},"timeoutMs":7000}');
});

test("a saved model that left the catalog opens selected and survives re-selection", async () => {
	const screen = screenContext();
	const stored: ProviderFallbackConfig = { model: { provider: "gone", id: "m" }, timeoutMs: 4000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx);
	await tick();
	assertEq(screen.component().render(80).join("\n").includes("gone/m (saved; unavailable)"), true);
	screen.component().handleInput("\r");
	await tick();
	assertEq(screen.component().render(80).join("\n").includes("gone/m (saved; unavailable)"), true);
	screen.component().handleInput("\r");
	await tick();
	assertEq(screen.component().render(80).join("\n").includes("gone/m (saved; unavailable)"), true);
	screen.component().handleInput("\u0013");
	assertEq(JSON.stringify(await opened), '{"model":{"provider":"gone","id":"m"},"timeoutMs":4000}');
});

test("an invalid timeout shows an error and leaves the stored value alone", async () => {
	const screen = screenContext();
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 20000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx);
	await tick();
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\r");
	await tick();
	screen.component().handleInput("x");
	screen.component().handleInput("\r");
	await tick();
	assertEq(screen.component().render(80).join("\n").includes("whole number"), true);
	let settled = false;
	void opened.then(() => {
		settled = true;
	});
	await tick();
	assertEq(settled, false);
	screen.component().handleInput("\u001b");
	await tick();
	screen.component().handleInput("\u0013");
	assertEq(JSON.stringify(await opened), '{"model":{"provider":"other","id":"fits"},"timeoutMs":20000}');
});

test("a valid timeout replaces the stored value", async () => {
	const screen = screenContext();
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 30000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx);
	await tick();
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\r");
	await tick();
	screen.component().handleInput("\u0005");
	for (let index = 0; index < 5; index += 1) {
		screen.component().handleInput("\u007f");
	}
	for (const digit of "450") {
		screen.component().handleInput(digit);
	}
	screen.component().handleInput("\r");
	await tick();
	screen.component().handleInput("\u0013");
	assertEq(JSON.stringify(await opened), '{"model":{"provider":"other","id":"fits"},"timeoutMs":450}');
});

/** Lets a pending custom() factory run. */
function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function model(provider: string, id: string) {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		reasoning: false,
	};
}

test("the command writes nothing when the screen is cancelled", async () => {
	const { FakePi, scratchDir } = await import("./harness.ts");
	const { ProviderCommand } = await import("../src/provider-command.ts");
	const { ProviderRegistry } = await import("../src/provider-registry.ts");
	const { ProviderStore } = await import("../src/provider-store.ts");

	const pi = new FakePi();
	const store = new ProviderStore(`${scratchDir()}/settings-cancel`);
	store.add("verboo", { baseUrl: "https://code.verboo.example/v1", fallback: { model: { provider: "other", id: "fits" }, timeoutMs: 5000 } });
	const registry = new ProviderRegistry(pi.extension());
	new ProviderCommand(pi.extension(), store, registry).register();

	const models = [model("verboo", "m"), model("other", "fits")];
	const registryStub = {
		getAll: () => models,
		find: (provider: string, id: string) => models.find((entry) => entry.provider === provider && entry.id === id),
		streamSimple: () => {
			throw new Error("unused");
		},
	};
	let component: { handleInput(data: string): void } | undefined;
	const ctx = {
		mode: "tui",
		modelRegistry: { refresh: async () => {}, ...registryStub },
		ui: {
			notify: () => {},
			select: async () => undefined,
			input: async () => undefined,
			custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value?: unknown) => void) => { handleInput(data: string): void }) =>
				new Promise((resolve) => {
					const theme = { fg: (_k: string, text: string) => text, bold: (text: string) => text };
					const keys = {
						matches: (data: string, id: string) => {
							const map: Record<string, string[]> = {
								"tui.select.up": ["\u001b[A"],
								"tui.select.down": ["\u001b[B"],
								"tui.select.confirm": ["\r"],
								"tui.select.cancel": ["\u001b"],
								"ctrl+s": ["\u0013"],
							};
							return (map[id] ?? []).includes(data);
						},
					};
					component = factory({ requestRender: () => {} }, theme, keys, resolve);
				}),
		},
	};
	registry.bindSession(registryStub as never);
	const before = JSON.stringify(store.all());
	const running = pi.command("providers", "settings verboo", ctx as never);
	for (let attempt = 0; attempt < 5 && !component; attempt += 1) {
		await tick();
	}
	component!.handleInput("\r");
	await tick();
	component!.handleInput("\u001b[B");
	component!.handleInput("\r");
	await tick();
	component!.handleInput("\u001b");
	await running;
	assertEq(JSON.stringify(store.all()), before);
	assertEq(pi.unregistered.length, 0);
});
