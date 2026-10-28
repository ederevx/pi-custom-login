/** The one-screen editor for a provider's fallback, laid out like pi's own settings lists. */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	Key,
	type KeybindingsManager,
	matchesKey,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";

import { DEFAULT_FALLBACK_TIMEOUT_MS, type ModelRef, type ProviderFallbackConfig } from "./provider-config.ts";
import { ProviderSettings } from "./provider-settings.ts";

/** The editable state; a disabled fallback keeps its timeout for the next enabling. */
export interface SettingsDraft {
	model: ModelRef | null;
	timeoutMs: number;
}

const DISABLED = "Disabled";

export class SettingsScreen {

	static items(draft: SettingsDraft, unavailable: ModelRef | undefined): SettingItem[] {
		return [
			{
				id: "fallback",
				label: "Fallback model",
				description: "Used when this provider's response does not start in time",
				currentValue: SettingsScreen.describe(draft.model, unavailable),
			},
			{
				id: "timeout",
				label: "Response-start timeout",
				description: "Milliseconds to wait for the first content of a response",
				currentValue: `${draft.timeoutMs} ms`,
			},
		];
	}

	/** A stored model the catalog no longer offers, shown rather than silently dropped. */
	static unavailable(stored: ProviderFallbackConfig | undefined, candidates: readonly ModelRef[]): ModelRef | undefined {
		if (!stored || candidates.some((candidate) => ProviderSettings.label(candidate) === ProviderSettings.label(stored.model))) {
			return undefined;
		}
		return stored.model;
	}

	/** Opens the editor; returns the saved configuration, null for Disabled, or undefined on cancel. */
	static async open(
		providerId: string,
		stored: ProviderFallbackConfig | undefined,
		candidates: readonly ModelRef[],
		ctx: ExtensionCommandContext,
	): Promise<ProviderFallbackConfig | null | undefined> {
		const draft: SettingsDraft = {
			model: stored?.model ?? null,
			timeoutMs: stored?.timeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS,
		};
		const unavailable = SettingsScreen.unavailable(stored, candidates);

		return ctx.ui.custom<ProviderFallbackConfig | null | undefined>((tui, theme, keybindings, done) => {
			let focused = false;
			let activeInput: Input | undefined;
			const setActiveInput = (input: Input | undefined): void => {
				if (activeInput) {
					activeInput.focused = false;
				}
				activeInput = input;
				if (activeInput) {
					activeInput.focused = focused;
				}
				tui.requestRender();
			};
			const container = new Container();
			const list = new SettingsList(
				SettingsScreen.items(draft, unavailable).map((item) => ({
					...item,
					submenu: item.id === "fallback"
						? SettingsScreen.pickFallback(draft, candidates, unavailable, theme, keybindings, setActiveInput)
						: SettingsScreen.editTimeout(theme, setActiveInput),
				})),
				6,
				SettingsScreen.listTheme(theme),
				(id, value) => {
					if (id === "fallback") {
						draft.model = value === DISABLED ? null : SettingsScreen.resolve(value, candidates, unavailable);
					} else {
						draft.timeoutMs = Number(value.replace(" ms", ""));
					}
				},
				() => done(undefined),
			);

			container.addChild(new Text(theme.fg("accent", theme.bold(`Fallback for ${providerId}`)), 1, 0));
			container.addChild(new Text(theme.fg("dim", "Enter: edit · Ctrl+S: save · Esc: cancel"), 1, 0));
			container.addChild(new Spacer(1));
			container.addChild(list);

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				get focused(): boolean {
					return focused;
				},
				set focused(value: boolean) {
					focused = value;
					if (activeInput) {
						activeInput.focused = value;
					}
				},
				handleInput: (data: string) => {
					if (!activeInput && matchesKey(data, Key.ctrl("s"))) {
						done(SettingsScreen.revision(draft));
						return;
					}
					list.handleInput(data);
					tui.requestRender();
				},
			};
		}, { overlay: true });
	}

	private static pickFallback(
		draft: SettingsDraft,
		candidates: readonly ModelRef[],
		unavailable: ModelRef | undefined,
		theme: Theme,
		keybindings: KeybindingsManager,
		setActiveInput: (input: Input | undefined) => void,
	) {
		return (_current: string, done: (value?: string) => void) => {
			const all: SelectItem[] = [{ value: DISABLED, label: DISABLED }];
			for (const candidate of candidates) {
				all.push({ value: ProviderSettings.label(candidate), label: ProviderSettings.label(candidate) });
			}
			if (unavailable) {
				all.push({ value: ProviderSettings.label(unavailable), label: SettingsScreen.describe(unavailable, unavailable) });
			}
			const initial = all.findIndex((item) => item.value === (draft.model ? ProviderSettings.label(draft.model) : DISABLED));
			const host = new Container();
			const search = new Input({ placeholder: "Search models" });
			setActiveInput(search);
			const state = { list: SettingsScreen.selectList(all, SettingsScreen.listTheme(theme), Math.max(0, initial), done, setActiveInput) };
			host.addChild(search);
			host.addChild(new Spacer(1));
			host.addChild({
				render: (width: number) => state.list.render(width),
				invalidate: () => state.list.invalidate(),
				handleInput: () => {},
			});
			return {
				render: (width: number) => host.render(width),
				invalidate: () => host.invalidate(),
				handleInput: (data: string) => {
					if (
						keybindings.matches(data, "tui.select.up") ||
						keybindings.matches(data, "tui.select.down") ||
						keybindings.matches(data, "tui.select.confirm") ||
						keybindings.matches(data, "tui.select.cancel")
					) {
						state.list.handleInput(data);
						return;
					}
					const before = search.getValue();
					search.handleInput(data);
					if (search.getValue() !== before) {
						const visible = fuzzyFilter(all, search.getValue(), (item) => item.label);
						state.list = SettingsScreen.selectList(visible, SettingsScreen.listTheme(theme), 0, done, setActiveInput);
					}
				},
			};
		};
	}

	private static selectList(
		items: readonly SelectItem[],
		theme: SettingsListTheme,
		index: number,
		done: (value?: string) => void,
		setActiveInput: (input: Input | undefined) => void,
	): SelectList {
		const selectTheme: SelectListTheme = {
			selectedPrefix: (text) => theme.label(text, true),
			selectedText: (text) => theme.label(text, true),
			description: theme.description,
			scrollInfo: theme.hint,
			noMatch: theme.hint,
		};
		const list = new SelectList([...items], 10, selectTheme);
		list.setSelectedIndex(index);
		list.onSelect = (item) => {
			setActiveInput(undefined);
			done(item.label);
		};
		list.onCancel = () => {
			setActiveInput(undefined);
			done();
		};
		return list;
	}

	/** A prefilled timeout field that keeps itself open until the value is a whole number of milliseconds. */
	private static editTimeout(
		theme: Theme,
		setActiveInput: (input: Input | undefined) => void,
	) {
		return (current: string, done: (value?: string) => void) => {
			const input = new Input({ placeholder: "Milliseconds" });
			input.setValue(current.replace(" ms", ""));
			const error = new Text("", 1, 0);
			const host = new Container();
			setActiveInput(input);
			input.onSubmit = (value: string) => {
				const parsed = ProviderSettings.parseTimeout(value);
				if (parsed === undefined) {
					error.setText(theme.fg("error", "Enter a whole number of milliseconds"));
					return;
				}
				setActiveInput(undefined);
				done(`${parsed} ms`);
			};
			input.onEscape = () => {
				setActiveInput(undefined);
				done();
			};
			host.addChild(new Text("Response-start timeout in milliseconds", 1, 0));
			host.addChild(input);
			host.addChild(error);
			return {
				render: (width: number) => host.render(width),
				invalidate: () => host.invalidate(),
				handleInput: (data: string) => input.handleInput(data),
			};
		};
	}

	private static listTheme(theme: Theme): SettingsListTheme {
		return {
			label: (text, selected) => (selected ? theme.fg("accent", text) : text),
			value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
			description: (text) => theme.fg("dim", text),
			cursor: theme.fg("accent", "→ "),
			hint: (text) => theme.fg("dim", text),
		};
	}

	private static revision(draft: SettingsDraft): ProviderFallbackConfig | null {
		return draft.model ? { model: draft.model, timeoutMs: draft.timeoutMs } : null;
	}

	private static resolve(value: string, candidates: readonly ModelRef[], unavailable: ModelRef | undefined): ModelRef | null {
		const match = candidates.find((candidate) => ProviderSettings.label(candidate) === value);
		if (match) {
			return match;
		}
		if (unavailable && SettingsScreen.describe(unavailable, unavailable) === value) {
			return unavailable;
		}
		return null;
	}

	private static describe(model: ModelRef | null, unavailable: ModelRef | undefined): string {
		if (!model) {
			return DISABLED;
		}
		const label = ProviderSettings.label(model);
		return unavailable && ProviderSettings.label(unavailable) === label ? `${label} (saved; unavailable)` : label;
	}
}
