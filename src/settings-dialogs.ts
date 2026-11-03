/** The command's menus: pi's own custom components in the TUI, plain dialogs in every other mode. */

import { DynamicBorder, getSelectListTheme, getSettingsListTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { SelectItem, SettingItem } from "@earendil-works/pi-tui";

import { SearchableSelect, type SearchableEntry, type SearchableSelectTheme } from "./searchable-select.ts";
import { SettingsScreen } from "./settings-screen.ts";

export interface SettingRow {
	readonly label: string;
	readonly value: string;
	readonly description: string;
	readonly choices: readonly string[];
}

export interface SettingChoice {
	readonly label: string;
	readonly choice: string;
}

export class SettingsDialogs {
	private readonly ctx: ExtensionCommandContext;

	constructor(ctx: ExtensionCommandContext) {
		this.ctx = ctx;
	}

	/** The picked value, or undefined when the user stepped back. */
	async pick(title: string, entries: readonly SearchableEntry[], pinned: readonly SelectItem[], searchable: boolean, selected?: string): Promise<string | undefined> {
		if (this.ctx.mode !== "tui") {
			return this.choose(title, [...entries.map((entry) => entry.item), ...pinned]);
		}
		return this.ctx.ui.custom<string | undefined>((_tui, theme, _keys, done) =>
			new SearchableSelect(title, entries, pinned, searchable, SettingsDialogs.framed(theme), selected, done),
		);
	}

	/** The row and choice picked, or undefined when the user stepped back. */
	async settings(title: string, rows: readonly SettingRow[], selected?: string): Promise<SettingChoice | undefined> {
		if (this.ctx.mode !== "tui") {
			return this.open(title, rows);
		}
		return this.ctx.ui.custom<SettingChoice | undefined>((_tui, theme, _keys, done) => {
			const plain = SettingsDialogs.plain(theme);
			const items = rows.map((row) => SettingsDialogs.item(row, plain));
			return new SettingsScreen(title, items, getSettingsListTheme(), { title: (text) => theme.bold(theme.fg("accent", text)), border: () => new DynamicBorder() }, selected, (result) =>
				done(result === undefined ? undefined : { label: result.id, choice: result.choice }),
			);
		});
	}

	/** A row's choices open as a list that answers with the chosen label. */
	private static item(row: SettingRow, theme: SearchableSelectTheme): SettingItem {
		const entries = row.choices.map((choice) => ({ item: { value: choice, label: choice }, search: choice }));
		return {
			id: row.label,
			label: row.label,
			description: row.description,
			currentValue: row.value,
			submenu: (_current, close) => new SearchableSelect(row.label, entries, [], false, theme, undefined, (choice) => close(choice)),
		};
	}

	private static framed(theme: Theme): SearchableSelectTheme {
		return { list: getSelectListTheme(), title: (text) => theme.bold(theme.fg("accent", text)), hint: (text) => theme.fg("dim", text), border: () => new DynamicBorder() };
	}

	private static plain(theme: Theme): SearchableSelectTheme {
		return { list: getSelectListTheme(), title: (text) => theme.bold(text), hint: (text) => theme.fg("dim", text) };
	}

	private static label(item: SelectItem): string {
		return item.description === undefined ? item.label : `${item.label} — ${item.description}`;
	}

	private async choose(title: string, items: readonly SelectItem[]): Promise<string | undefined> {
		const labels = items.map((item) => SettingsDialogs.label(item));
		const choice = await this.ctx.ui.select(title, labels);
		if (choice === undefined) {
			return undefined;
		}
		const index = labels.indexOf(choice);
		return index === -1 ? undefined : items[index]?.value;
	}

	private async open(title: string, rows: readonly SettingRow[]): Promise<SettingChoice | undefined> {
		for (;;) {
			const label = await this.ctx.ui.select(title, rows.map((row) => row.label));
			const row = rows.find((candidate) => candidate.label === label);
			if (row === undefined) {
				return undefined;
			}
			const choice = await this.ctx.ui.select(`${row.label} (current: ${row.value})`, [...row.choices]);
			if (choice === undefined) {
				continue;
			}
			return { label: row.label, choice };
		}
	}
}
