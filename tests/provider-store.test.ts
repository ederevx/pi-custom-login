import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertEq, assertThrows, scratchDir, test } from "./harness.ts";
import { ProviderStore } from "../src/provider-store.ts";

function store(subdirectory: string): ProviderStore {
	return new ProviderStore(join(scratchDir(), subdirectory));
}

test("an absent file means no providers", () => {
	assertEq(Object.keys(store("store-absent").all()).length, 0);
});

test("add writes the provider under its id", () => {
	const providers = store("store-add");
	providers.add("verboo", { baseUrl: "https://code.verboo.ai/router/v1", apiKey: "$VERBOO_API_KEY" });
	const written = JSON.parse(readFileSync(join(scratchDir(), "store-add", "custom-providers.json"), "utf8"));
	assertEq(written.providers.verboo.baseUrl, "https://code.verboo.ai/router/v1");
	assertEq(written.providers.verboo.apiKey, "$VERBOO_API_KEY");
});

test("add keeps the providers already stored", () => {
	const providers = store("store-keep");
	providers.add("first", { baseUrl: "https://first.example/v1" });
	providers.add("second", { name: "Second", baseUrl: "https://second.example/v1" });
	const stored = providers.all();
	assertEq(Object.keys(stored).join(","), "first,second");
	assertEq(stored.second.name, "Second");
});

test("remove drops only the named provider", () => {
	const providers = store("store-remove");
	providers.add("first", { baseUrl: "https://first.example/v1" });
	providers.add("second", { baseUrl: "https://second.example/v1" });
	providers.remove("first");
	assertEq(Object.keys(providers.all()).join(","), "second");
});

test("a malformed file fails instead of hiding the damage", () => {
	const providers = store("store-malformed");
	providers.add("first", { baseUrl: "https://first.example/v1" });
	const path = join(scratchDir(), "store-malformed", "custom-providers.json");
	writeFileSync(path, "{ not json");
	assertThrows(() => providers.all(), "JSON");
});

