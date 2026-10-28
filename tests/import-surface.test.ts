/**
 * Guards the imports an installed extension can actually resolve.
 *
 * pi loads an extension through jiti with a fixed alias map, from a clone that
 * has no `node_modules`; the dev checkout has symlinks that resolve more than
 * that map does, so an unaliased subpath passes here and fails once installed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertEq, test } from "./harness.ts";

/** The specifiers pi's extension loader aliases, plus the typebox entries it adds. */
const HOST_PROVIDED = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-ai/models",
	"@earendil-works/pi-ai/oauth",
	"@earendil-works/pi-ai/providers/all",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
	"typebox/compile",
	"typebox/value",
]);

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("src imports only what pi's extension loader provides", () => {
	const stray = readdirSync(src)
		.flatMap((file) => [...readFileSync(join(src, file), "utf8").matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)]
			.map((match) => match[1])
			.filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:") && !HOST_PROVIDED.has(specifier))
			.map((specifier) => `${file}: ${specifier}`));
	assertEq(stray.join("\n"), "");
});
