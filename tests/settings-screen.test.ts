import type { SettingItem } from "@earendil-works/pi-tui";

import { assertEq, test } from "./harness.ts";
import { SearchableSelect, type SearchableSelectTheme } from "../src/searchable-select.ts";
import { SettingsScreen, type SettingsScreenResult } from "../src/settings-screen.ts";

const PLAIN: SearchableSelectTheme = {
	list: { selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text },
	title: (text) => text,
	hint: (text) => text,
};

const SETTINGS_THEME = { label: (text: string) => text, value: (text: string) => text, description: (text: string) => text, cursor: "→ ", hint: (text: string) => text };

function item(label: string, currentValue: string, choices: readonly string[]): SettingItem {
	const entries = choices.map((choice) => ({ item: { value: choice, label: choice }, search: choice }));
	return { id: label, label, description: "test", currentValue, submenu: (_current, close) => new SearchableSelect(label, entries, [], false, PLAIN, undefined, (choice) => close(choice)) };
}

function screen(items: readonly SettingItem[], answers: Array<SettingsScreenResult | undefined>): SettingsScreen {
	return new SettingsScreen("verboo / glm-5.2", items, SETTINGS_THEME, { title: (text) => text }, undefined, (result) => answers.push(result));
}

test("a row shows its current value beside its name", async () => {
	const lines = screen([item("contextWindow", "1000000", ["Edit value"]), item("headers", "not set", ["Edit value"])], []).render(80).join("\n");
	assertEq(lines.includes("contextWindow"), true);
	assertEq(lines.includes("1000000"), true);
	assertEq(lines.includes("not set"), true);
});

test("enter on a row opens its choices and answers the pair", async () => {
	const answers: Array<SettingsScreenResult | undefined> = [];
	const subject = screen([item("reasoning", "true", ["true", "false"])], answers);
	subject.handleInput("\r");
	subject.handleInput("\x1b[B");
	subject.handleInput("\r");
	assertEq(JSON.stringify(answers.at(-1)), JSON.stringify({ id: "reasoning", choice: "false" }));
});

test("escape inside a row's choices returns to the fields without answering", async () => {
	const answers: Array<SettingsScreenResult | undefined> = [];
	const subject = screen([item("reasoning", "true", ["true", "false"])], answers);
	subject.handleInput("\r");
	subject.handleInput("\x1b");
	assertEq(answers.length, 0);
	subject.handleInput("\r");
	subject.handleInput("\x1b[B");
	subject.handleInput("\r");
	assertEq(JSON.stringify(answers.at(-1)), JSON.stringify({ id: "reasoning", choice: "false" }));
});

test("escape on the fields answers nothing, which steps back a screen", async () => {
	const answers: Array<SettingsScreenResult | undefined> = [];
	screen([item("reasoning", "true", ["true", "false"])], answers).handleInput("\x1b");
	assertEq(answers.length, 1);
	assertEq(answers[0], undefined);
});

test("typing on the fields narrows them by name", async () => {
	const subject = screen([item("contextWindow", "1000000", ["Edit value"]), item("headers", "not set", ["Edit value"])], []);
	for (const key of "head") subject.handleInput(key);
	const lines = subject.render(80).join("\n");
	assertEq(lines.includes("headers"), true);
	assertEq(lines.includes("contextWindow"), false);
});
