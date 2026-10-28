/** The one-screen editor for a provider's fallback, laid out like pi's own settings lists. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, type SelectListTheme, type SettingItem, SettingsList, Spacer, Text, type Theme } from "@earendil-works/pi-tui";

import { DEFAULT_FALLBACK_TIMEOUT_MS, type ModelRef, type ProviderFallbackConfig } from "./provider-config.ts";
import { ProviderSettings } from "./provider-settings.ts";

/** The editable state; a disabled fallback keeps its timeout for the next enabling. */
export interface SettingsDraft {
	model: ModelRef | null;
	timeoutMs: number;
}

/** Ctrl+S saves, so Escape can stay "leave this field" without discarding work. */
const SAVE = "\u0013";
const DISABLED = "Disabled";


export class SettingsScreen {
	/** Rows shown by the editor, kept separate so the layout is assertable without a terminal. */
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
		if (!stored || SettingsScreen.offered(stored.model, candidates)) {
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

		return ctx.ui.custom<ProviderFallbackConfig | null | undefined>((tui, theme, _keybindings, done) => {
			let editing = false;
			const container = new Container();
			const list = new SettingsList(
				SettingsScreen.rows(draft, candidates, unavailable, (next) => {
					editing = next;
					tui.requestRender();
				}),
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
				handleInput: (data: string) => {
					if (!editing && data === SAVE) {
						done(SettingsScreen.revision(draft));
						return;
					}
					list.handleInput(data);
					tui.requestRender();
				},
			};
		}, { overlay: true });
	}

	/** Rows with their submenus attached; `items()` stays the pure description of the same rows. */
	private static rows(
		draft: SettingsDraft,
		candidates: readonly ModelRef[],
		unavailable: ModelRef | undefined,
		editing: (open: boolean) => void,
	): SettingItem[] {
		return SettingsScreen.items(draft, unavailable).map((item) => ({
			...item,
			submenu: item.id === "fallback"
				? SettingsScreen.pickFallback(draft, candidates, unavailable, editing)
				: SettingsScreen.editTimeout(draft, editing),
		}));
	}

	private static pickFallback(
		draft: SettingsDraft,
		candidates: readonly ModelRef[],
		unavailable: ModelRef | undefined,
		editing: (open: boolean) => void,
	) {
		return (current: string, done: (value?: string) => void) => {
			editing(true);
			const labels = [DISABLED, ...candidates.map(ProviderSettings.label)];
			if (unavailable && !labels.includes(ProviderSettings.label(unavailable))) {
				labels.push(SettingsScreen.describe(unavailable, undefined));
			}
			const items = labels.map((label) => ({ value: label, label }));
			const list = new SelectList(items, 10, SettingsScreen.theme());
			list.setSelectedIndex(Math.max(0, labels.indexOf(current)));
			list.onSelect = (item) => {
				editing(false);
				done(item.value);
			};
			list.onCancel = () => {
				editing(false);
				done();
			};
			const host = new Container();
			const search = new Input({ placeholder: "Search models" });
			host.addChild(search);
			host.addChild(new Spacer(1));
			host.addChild(list);
			search.onSubmit = () => {
				const selected = list.getSelectedItem();
				if (selected) {
					editing(false);
					done(selected.value);
				}
			};
			return {
				render: (width: number) => host.render(width),
				invalidate: () => host.invalidate(),
				handleInput: (data: string) => {
					search.handleInput(data);
					list.setFilter(search.getValue());
				},
			};
		};
	}

	private static editTimeout(draft: SettingsDraft, editing: (open: boolean) => void) {
		return (current: string, done: (value?: string) => void) => {
			editing(true);
			const input = new Input({ placeholder: "Milliseconds" });
			input.setValue(current.replace(" ms", ""));
			const host = new Container();
			host.addChild(new Text("Response-start timeout in milliseconds", 1, 0));
			host.addChild(input);
			input.onSubmit = (value) => {
				const parsed = ProviderSettings.parseTimeout(value);
				if (parsed === undefined) {
					return;
				}
				editing(false);
				draft.timeoutMs = parsed;
				done(`${parsed} ms`);
			};
			input.onEscape = () => {
				editing(false);
				done();
			};
			return {
				render: (width: number) => host.render(width),
				invalidate: () => host.invalidate(),
				handleInput: (data: string) => input.handleInput(data),
			};
		};
	}

	private static listTheme(theme: Theme) {
		return {
			label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
			value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
			description: (text: string) => theme.fg("dim", text),
			cursor: theme.fg("accent", "→ "),
			hint: (text: string) => theme.fg("dim", text),
		};
	}

	private static theme(): SelectListTheme {
		const plain = (text: string) => text;
		return { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain };
	}

	private static revision(draft: SettingsDraft): ProviderFallbackConfig | null {
		return draft.model ? { model: draft.model, timeoutMs: draft.timeoutMs } : null;
	}

	private static offered(model: ModelRef, candidates: readonly ModelRef[]): boolean {
		return candidates.some((candidate) => ProviderSettings.label(candidate) === ProviderSettings.label(model));
	}

	private static resolve(value: string, candidates: readonly ModelRef[], unavailable: ModelRef | undefined): ModelRef | null {
		const match = candidates.find((candidate) => ProviderSettings.label(candidate) === value);
		if (match) {
			return match;
		}
		return unavailable && SettingsScreen.describe(unavailable, undefined) === value ? unavailable : null;
	}

	private static describe(model: ModelRef | null, unavailable: ModelRef | undefined): string {
		if (!model) {
			return DISABLED;
		}
		const label = ProviderSettings.label(model);
		return unavailable && ProviderSettings.label(unavailable) === label ? `${label} (saved; unavailable)` : label;
	}
}
