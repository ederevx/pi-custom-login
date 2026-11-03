/** One model's field list as a custom UI: pi's searchable settings list between two borders. */

import { Container, SettingsList, Spacer, Text, type Component, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";

export interface SettingsScreenResult {
	readonly id: string;
	readonly choice: string;
}

export interface SettingsScreenStyle {
	readonly title: (text: string) => string;
	readonly border?: () => Component;
}

export class SettingsScreen extends Container {
	private static readonly MAX_VISIBLE = 10;

	private readonly list: SettingsList;

	constructor(title: string, items: readonly SettingItem[], theme: SettingsListTheme, style: SettingsScreenStyle, selected: string | undefined, done: (result: SettingsScreenResult | undefined) => void) {
		super();
		if (style.border) {
			this.addChild(style.border());
		}
		this.addChild(new Text(style.title(title), 0, 0));
		this.addChild(new Spacer(1));
		this.list = new SettingsList([...items], SettingsScreen.MAX_VISIBLE, theme, (id, choice) => done({ id, choice }), () => done(undefined), { enableSearch: true });
		this.addChild(this.list);
		if (style.border) {
			this.addChild(style.border());
		}
		if (selected !== undefined) {
			this.list.selectItem(selected);
		}
	}

	/** The screen owns focus, so its keys reach the list. */
	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}
}
