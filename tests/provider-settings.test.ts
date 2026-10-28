import { assertEq, test } from "./harness.ts";
import { MAX_TIMEOUT_MS, type ProviderFallbackConfig } from "../src/provider-config.ts";
import { ProviderSettings, type CatalogEntry } from "../src/provider-settings.ts";
import { SettingsScreen, type SettingsDraft } from "../src/settings-screen.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

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
			return (map[id] ?? []).includes(data);
		},
	};
	const theme = { fg: (_key: string, text: string) => text };
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

test("the screen renders both rows with their current values", async () => {
	const screen = screenContext();
	const applied: unknown[] = [];
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 5000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx, (value) => applied.push(value));
	await tick();
	const rendered = screen.component().render(80).join("\n");
	assertEq(rendered.includes("Fallback model"), true);
	assertEq(rendered.includes("other/fits"), true);
	assertEq(rendered.includes("Response-start timeout"), true);
	assertEq(rendered.includes("5000 ms"), true);
	screen.component().handleInput("\u001b");
	await opened;
});

test("choosing a model applies it immediately", async () => {
	const screen = screenContext();
	const applied: unknown[] = [];
	const opened = SettingsScreen.open("verboo", undefined, [{ provider: "other", id: "fits" }], screen.ctx, (value) => applied.push(value));
	await tick();
	screen.component().handleInput("\r");
	await tick();
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\r");
	await tick();
	assertEq(JSON.stringify(applied), '[{"model":{"provider":"other","id":"fits"},"timeoutMs":30000}]');
	screen.component().handleInput("\u001b");
	await opened;
});

test("choosing Disabled applies a null fallback", async () => {
	const screen = screenContext();
	const applied: unknown[] = [];
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 5000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx, (value) => applied.push(value));
	await tick();
	screen.component().handleInput("\r");
	await tick();
	screen.component().handleInput("\u001b[A");
	screen.component().handleInput("\r");
	await tick();
	assertEq(applied.at(-1), null);
	screen.component().handleInput("\u001b");
	await opened;
});

test("the fallback list is searchable and Enter picks the visible match", async () => {
	const screen = screenContext();
	const applied: unknown[] = [];
	const candidates = [
		{ provider: "other", id: "fits" },
		{ provider: "another", id: "wide" },
	];
	const opened = SettingsScreen.open("verboo", undefined, candidates, screen.ctx, (value) => applied.push(value));
	await tick();
	screen.component().handleInput("\r");
	await tick();
	const menu = screen.component().render(80).join("\n");
	assertEq(menu.includes("Disabled"), true);
	assertEq(menu.includes("other/fits"), true);
	assertEq(menu.includes("another/wide"), true);
	for (const key of "wide") {
		screen.component().handleInput(key);
	}
	await tick();
	screen.component().handleInput("\r");
	await tick();
	assertEq(JSON.stringify(applied.at(-1)), '{"model":{"provider":"another","id":"wide"},"timeoutMs":30000}');
	screen.component().handleInput("\u001b");
	await opened;
});

test("arrows move inside the fallback list", async () => {
	const screen = screenContext();
	const applied: unknown[] = [];
	const candidates = [
		{ provider: "other", id: "fits" },
		{ provider: "another", id: "wide" },
	];
	const opened = SettingsScreen.open("verboo", undefined, candidates, screen.ctx, (value) => applied.push(value));
	await tick();
	screen.component().handleInput("\r");
	await tick();
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\r");
	await tick();
	assertEq(JSON.stringify(applied.at(-1)), '{"model":{"provider":"another","id":"wide"},"timeoutMs":30000}');
	screen.component().handleInput("\u001b");
	await opened;
});

test("the open row's input carries the hardware cursor only while focused", async () => {
	const screen = screenContext();
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 30000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx, () => {});
	await tick();
	screen.component().focused = true;
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\r");
	await tick();
	assertEq(screen.component().render(80).join("\n").includes(CURSOR_MARKER), true);
	screen.component().focused = false;
	assertEq(screen.component().render(80).join("\n").includes(CURSOR_MARKER), false);
	screen.component().handleInput("\u001b");
	screen.component().handleInput("\u001b");
	await opened;
});

test("focus set after a row opens also reaches the input", async () => {
	const screen = screenContext();
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 30000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx, () => {});
	await tick();
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\r");
	await tick();
	assertEq(screen.component().render(80).join("\n").includes(CURSOR_MARKER), false);
	screen.component().focused = true;
	assertEq(screen.component().render(80).join("\n").includes(CURSOR_MARKER), true);
	screen.component().handleInput("\u001b");
	screen.component().handleInput("\u001b");
	await opened;
});

test("escape closes without applying anything", async () => {
	const screen = screenContext();
	const applied: unknown[] = [];
	const opened = SettingsScreen.open("verboo", undefined, [], screen.ctx, (value) => applied.push(value));
	await tick();
	screen.component().handleInput("\u001b");
	await opened;
	assertEq(applied.length, 0);
});

test("a saved model that left the catalog still shows and keeps its identity", async () => {
	const screen = screenContext();
	const applied: unknown[] = [];
	const stored: ProviderFallbackConfig = { model: { provider: "gone", id: "m" }, timeoutMs: 4000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx, (value) => applied.push(value));
	await tick();
	assertEq(screen.component().render(80).join("\n").includes("gone/m (saved; unavailable)"), true);
	screen.component().handleInput("\r");
	await tick();
	assertEq(screen.component().render(80).join("\n").includes("gone/m (saved; unavailable)"), true);
	screen.component().handleInput("\r");
	await tick();
	assertEq(JSON.stringify(applied.at(-1)), '{"model":{"provider":"gone","id":"m"},"timeoutMs":4000}');
	screen.component().handleInput("\u001b");
	await opened;
});

test("an invalid timeout shows an error and applies nothing", async () => {
	const screen = screenContext();
	const applied: unknown[] = [];
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 20000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx, (value) => applied.push(value));
	await tick();
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\r");
	await tick();
	clearInput(screen.component());
	screen.component().handleInput("x");
	screen.component().handleInput("\r");
	await tick();
	assertEq(screen.component().render(80).join("\n").includes("whole number"), true);
	assertEq(applied.length, 0);
	// The first Escape only leaves the timeout row; the screen is still open.
	screen.component().handleInput("\u001b");
	await tick();
	assertEq(screen.component().render(80).join("\n").includes("Fallback model"), true);
	screen.component().handleInput("\u001b");
	await opened;
});

test("a valid timeout applies the new value", async () => {
	const screen = screenContext();
	const applied: unknown[] = [];
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 30000 };
	const opened = SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], screen.ctx, (value) => applied.push(value));
	await tick();
	screen.component().handleInput("\u001b[B");
	screen.component().handleInput("\r");
	await tick();
	assertEq(plain(screen.component()).includes("30000"), true);
	clearInput(screen.component());
	for (const digit of "450") {
		screen.component().handleInput(digit);
	}
	screen.component().handleInput("\r");
	await tick();
	assertEq(JSON.stringify(applied.at(-1)), '{"model":{"provider":"other","id":"fits"},"timeoutMs":450}');
	screen.component().handleInput("\u001b");
	await opened;
});

/** The rendered screen without pi's inline escape sequences (cursor markers). */
function plain(component: { render(width: number): string[] }): string {
	return component.render(80).join("\n").replace(/\u001b[^\u0007]*\u0007/g, "");
}

/** Selects everything in the open input so typing replaces it. */
function clearInput(screen: { handleInput(data: string): void }): void {
	screen.handleInput("\u0001");
	screen.handleInput("\u000b");
}

/** Lets a pending custom() factory run. */
function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
