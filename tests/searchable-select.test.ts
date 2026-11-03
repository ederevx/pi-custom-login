import { assertEq, test } from "./harness.ts";
import { SearchableSelect, type SearchableEntry, type SearchableSelectTheme } from "../src/searchable-select.ts";

const THEME: SearchableSelectTheme = {
	list: { selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text },
	title: (text) => text,
	hint: (text) => text,
};

function model(id: string, name: string): SearchableEntry {
	return { item: { value: id, label: id, description: name }, search: `verboo verboo/${id} verboo ${id} ${name}` };
}

function screen(entries: readonly SearchableEntry[], answers: Array<string | undefined>, searchable = true): { select: SearchableSelect; offer: (id: string) => void } {
	const offer = (id: string): void => {
		answers.push(id);
	};
	const select = new SearchableSelect("Model", entries, [{ value: "", label: "Enter a model id" }], searchable, THEME, undefined, (value) => offer(value ?? "back"));
	return { select, offer };
}

test("typing narrows the list to the fuzzy matches", async () => {
	const { select } = screen([model("glm-5.2", "GLM 5.2"), model("m2", "M2")], []);
	for (const key of ["g", "l", "m"]) select.handleInput(key);
	const lines = select.render(80).join("\n");
	assertEq(lines.includes("glm-5.2"), true);
	assertEq(lines.includes("m2 — M2"), false);
	assertEq(lines.includes("Enter a model id"), true);
});

test("a provider-prefixed query matches through both tokens", async () => {
	const { select } = screen([model("glm-5.2", "GLM 5.2"), model("m2", "M2")], []);
	for (const key of "verboo/glm") select.handleInput(key);
	const lines = select.render(80).join("\n");
	assertEq(lines.includes("glm-5.2"), true);
	assertEq(lines.includes("m2 — M2"), false);
});

test("enter answers with the highlighted model", async () => {
	const answers: Array<string | undefined> = [];
	const { select } = screen([model("glm-5.2", "GLM 5.2")], answers);
	select.handleInput("\r");
	assertEq(answers.at(-1), "glm-5.2");
});

test("escape answers with nothing, which steps the command back", async () => {
	const answers: Array<string | undefined> = [];
	const { select } = screen([model("glm-5.2", "GLM 5.2")], answers);
	select.handleInput("\x1b");
	assertEq(answers.at(-1), "back");
});

test("the pinned entry answers with an empty value and survives the search", async () => {
	const answers: Array<string | undefined> = [];
	const { select } = screen([model("glm-5.2", "GLM 5.2")], answers);
	for (const key of ["g", "l", "m"]) select.handleInput(key);
	select.handleInput("\r");
	assertEq(answers.at(-1), "glm-5.2");
	for (const key of ["z", "z"]) select.handleInput(key);
	select.handleInput("\r");
	assertEq(answers.at(-1), "");
});

test("a list without search passes typed keys straight through", async () => {
	const answers: Array<string | undefined> = [];
	const select = new SearchableSelect("Provider", [{ item: { value: "verboo", label: "verboo", description: "https://code.verboo.ai/router/v1" }, search: "verboo" }], [], false, THEME, undefined, (value) => answers.push(value ?? "back"));
	select.handleInput("g");
	select.handleInput("\r");
	assertEq(answers.at(-1), "verboo");
});
