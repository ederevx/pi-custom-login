/** The inline editor for a provider's fallback, shaped like pi's own /settings screen. */

import { DynamicBorder, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	type KeybindingsManager,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	Spacer,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
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
	/** Rows shown by the editor. */
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
				description: draft.model
					? "Milliseconds to wait for the first content of a response"
					: "Milliseconds to wait for the first content of a response; saved once a fallback is chosen",
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

	/** Applies each edit as it is made, like pi's /settings; Escape closes. */
	static async open(
		providerId: string,
		stored: ProviderFallbackConfig | undefined,
		candidates: readonly ModelRef[],
		ctx: ExtensionCommandContext,
		apply: (config: ProviderFallbackConfig | null) => void,
	): Promise<void> {
		const draft: SettingsDraft = {
			model: stored?.model ?? null,
			timeoutMs: stored?.timeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS,
		};
		const unavailable = SettingsScreen.unavailable(stored, candidates);

		return ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			let activeInput: Input | undefined;
			let focused = false;
			const container = new Container();
			const border = () => new DynamicBorder((text: string) => theme.fg("border", text));
			const list = new SettingsList(
				SettingsScreen.items(draft, unavailable).map((item) => ({
					...item,
					submenu: (current: string, finish: (value?: string) => void) => {
						const close = (value?: string) => {
							activeInput = undefined;
							finish(value);
						};
						const built = item.id === "fallback"
							? SettingsScreen.pickFallback(draft, candidates, unavailable, theme, keybindings, close)
							: SettingsScreen.editTimeout(current, theme, close);
						activeInput = built.input;
						activeInput.focused = focused;
						tui.requestRender();
						return built.component;
					},
				})),
				10,
				SettingsScreen.listTheme(theme),
				(id, value) => {
					if (id === "fallback") {
						draft.model = SettingsScreen.resolve(value, candidates, unavailable);
						apply(SettingsScreen.revision(draft));
						return;
					}
					draft.timeoutMs = Number(value.replace(" ms", ""));
					if (draft.model) {
						apply(SettingsScreen.revision(draft));
					}
				},
				() => done(undefined),
			);

			container.addChild(border());
			container.addChild(list);
			container.addChild(border());

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
					list.handleInput(data);
					tui.requestRender();
				},
				handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => list.handleMouse(event),
			};
		});
	}

	private static pickFallback(
		draft: SettingsDraft,
		candidates: readonly ModelRef[],
		unavailable: ModelRef | undefined,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (value?: string) => void,
	): { component: Container; input: Input } {
		const all: SelectItem[] = [{ value: DISABLED, label: DISABLED }];
		for (const candidate of candidates) {
			all.push({ value: ProviderSettings.label(candidate), label: ProviderSettings.label(candidate) });
		}
		if (unavailable) {
			all.push({ value: ProviderSettings.label(unavailable), label: SettingsScreen.describe(unavailable, unavailable) });
		}

		const search = new Input();
		const listHost = new Container();
		let list = SettingsScreen.selectList(all, SettingsScreen.listTheme(theme), SettingsScreen.indexOf(all, draft));
		listHost.addChild(list);

		const rebuild = (query: string) => {
			const visible = SettingsScreen.filter(all, query);
			const index = query.trim() === "" ? SettingsScreen.indexOf(all, draft) : 0;
			list = SettingsScreen.selectList(visible, SettingsScreen.listTheme(theme), index);
			listHost.clear();
			listHost.addChild(list);
		};

		const host = new Container();
		host.addChild(search);
		host.addChild(new Spacer(1));
		host.addChild(listHost);
		return {
			input: search,
			component: Object.assign(host, {
				handleInput: (data: string) => {
					if (keybindings.matches(data, "tui.select.cancel")) {
						done();
						return;
					}
					if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
						list.handleInput(data);
						return;
					}
					// Both pi-tui's Input and pi's own screens also submit on a bare newline.
					if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
						const chosen = list.getSelectedItem();
						if (chosen) {
							done(chosen.label);
						}
						return;
					}
					const before = search.getValue();
					search.handleInput(data);
					if (search.getValue() !== before) {
						rebuild(search.getValue());
					}
				},
			}),
		};
	}

	private static editTimeout(current: string, theme: Theme, done: (value?: string) => void): { component: Container; input: Input } {
		const error = new Text("", 0, 0);
		const input = new Input();
		input.setValue(current.replace(" ms", ""));
		input.onSubmit = (value: string) => {
			const parsed = ProviderSettings.parseTimeout(value);
			if (parsed === undefined) {
				error.setText(theme.fg("error", "Enter a whole number of milliseconds"));
				return;
			}
			done(`${parsed} ms`);
		};
		input.onEscape = () => done();
		const host = new Container();
		host.addChild(new Text(theme.fg("muted", "Response-start timeout in milliseconds"), 0, 0));
		host.addChild(new Spacer(1));
		host.addChild(input);
		host.addChild(error);
		return {
			input,
			component: Object.assign(host, {
				handleInput: (data: string) => input.handleInput(data),
			}),
		};
	}

	private static selectList(items: readonly SelectItem[], theme: SettingsListTheme, index: number): SelectList {
		const selectTheme: SelectListTheme = {
			selectedPrefix: (text) => theme.label(text, true),
			selectedText: (text) => theme.label(text, true),
			description: theme.description,
			scrollInfo: theme.hint,
			noMatch: theme.hint,
		};
		const list = new SelectList([...items], 10, selectTheme);
		list.setSelectedIndex(index);
		return list;
	}

	private static indexOf(items: readonly SelectItem[], draft: SettingsDraft): number {
		const wanted = draft.model ? ProviderSettings.label(draft.model) : DISABLED;
		return Math.max(0, items.findIndex((item) => item.value === wanted));
	}

	private static filter(items: readonly SelectItem[], query: string): SelectItem[] {
		const needle = query.trim().toLowerCase();
		return needle === "" ? [...items] : items.filter((item) => item.label.toLowerCase().includes(needle));
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

	/** Nothing is stored while the fallback is disabled; the timeout waits for a model. */
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
