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

/** A TUI context whose custom() builds the component and captures its result. */
function screenContext() {
	const captured: { component?: { render(width: number): string[]; handleInput(data: string): void }; resolved: unknown } = { resolved: "unset" };
	const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value?: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => {
				captured.component = factory({ requestRender: () => {} }, theme, {}, (value?: unknown) => {
					captured.resolved = value;
				});
				return undefined;
			},
			notify: () => {},
		},
	} as unknown as ExtensionCommandContext;
	return { captured, ctx };
}

test("saving the screen returns the edited configuration", async () => {
	const { captured, ctx } = screenContext();
	const stored: ProviderFallbackConfig = { model: { provider: "other", id: "fits" }, timeoutMs: 5000 };
	assertEq(await SettingsScreen.open("verboo", stored, [{ provider: "other", id: "fits" }], ctx), undefined);
	const rendered = captured.component!.render(80).join("\n");
	assertEq(rendered.includes("Fallback for verboo"), true);
	assertEq(rendered.includes("other/fits"), true);
	assertEq(rendered.includes("5000 ms"), true);
	captured.component!.handleInput("\u0013");
	assertEq(JSON.stringify(captured.resolved), '{"model":{"provider":"other","id":"fits"},"timeoutMs":5000}');
});

test("cancelling the screen writes nothing", async () => {
	const { captured, ctx } = screenContext();
	await SettingsScreen.open("verboo", undefined, [], ctx);
	captured.component!.handleInput("\u001b");
	assertEq(captured.resolved, undefined);
});

test("a disabled provider saves as null so the caller deletes the setting", async () => {
	const { captured, ctx } = screenContext();
	await SettingsScreen.open("verboo", undefined, [{ provider: "other", id: "fits" }], ctx);
	captured.component!.handleInput("\u0013");
	assertEq(captured.resolved, null);
});
