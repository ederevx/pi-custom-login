/** A titled select list that narrows by fuzzy search as the user types; Escape answers undefined. */

import { Container, fuzzyFilter, getKeybindings, Input, SelectList, Spacer, Text, type Component, type Focusable, type SelectItem, type SelectListTheme } from "@earendil-works/pi-tui";

export interface SearchableEntry {
	readonly item: SelectItem;
	readonly search: string;
}

export interface SearchableSelectTheme {
	readonly list: SelectListTheme;
	readonly title: (text: string) => string;
	readonly hint: (text: string) => string;
	readonly border?: () => Component;
}

export class SearchableSelect extends Container implements Focusable {
	private static readonly MAX_VISIBLE = 10;
	/** Keys the list owns; everything else is typed into the search box. */
	private static readonly NAVIGATION: readonly string[] = ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel"];

	private readonly entries: readonly SearchableEntry[];
	private readonly pinned: readonly SelectItem[];
	private readonly theme: SearchableSelectTheme;
	private readonly done: (value: string | undefined) => void;
	private readonly search: Input | undefined;
	private readonly listIndex: number;
	private list: SelectList;
	private focusedState = false;

	constructor(title: string, entries: readonly SearchableEntry[], pinned: readonly SelectItem[], searchable: boolean, theme: SearchableSelectTheme, selected: string | undefined, done: (value: string | undefined) => void) {
		super();
		this.entries = entries;
		this.pinned = pinned;
		this.theme = theme;
		this.done = done;
		if (theme.border) {
			this.addChild(theme.border());
		}
		this.addChild(new Text(theme.title(title), 0, 0));
		this.addChild(new Spacer(1));
		if (searchable) {
			this.search = new Input();
			this.search.onSubmit = () => this.list.handleInput("\r");
			this.addChild(this.search);
			this.addChild(new Spacer(1));
		}
		this.list = this.build(this.entries.map((entry) => entry.item), selected);
		this.listIndex = this.children.length;
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.hint(searchable ? "  Type to search · Enter to select · Esc to go back" : "  Enter to select · Esc to go back"), 0, 0));
	}

	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
		if (this.search) {
			this.search.focused = value;
		}
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (this.search === undefined || SearchableSelect.NAVIGATION.some((action) => keys.matches(data, action))) {
			this.list.handleInput(data);
			return;
		}
		this.search.handleInput(data);
		const matched = fuzzyFilter(this.entries, this.search.getValue(), (entry) => entry.search);
		this.list = this.build(matched.map((entry) => entry.item), undefined);
		this.children[this.listIndex] = this.list;
	}

	/** The pinned entries stay outside the filter, so a list always has something to answer. */
	private build(items: readonly SelectItem[], selected: string | undefined): SelectList {
		const all = [...items, ...this.pinned];
		const list = new SelectList(all, Math.min(Math.max(all.length, 1), SearchableSelect.MAX_VISIBLE), this.theme.list);
		const index = selected === undefined ? -1 : all.findIndex((item) => item.value === selected);
		if (index !== -1) {
			list.setSelectedIndex(index);
		}
		list.onSelect = (item) => this.done(item.value);
		list.onCancel = () => this.done(undefined);
		return list;
	}
}
