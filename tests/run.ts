import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupScratch, registry } from "./harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
	execFileSync("python3", ["tests/oop_lint.py"], { cwd: repoRoot, stdio: "inherit" });
} catch {
	console.error("oop lint: FAILED");
	process.exit(1);
}

import "./import-surface.test.ts";
import "./provider-store.test.ts";
import "./model-catalog.test.ts";
import "./provider-command.test.ts";
import "./provider-settings.test.ts";
import "./provider-fallback.test.ts";

await registry.runAll();
cleanupScratch();
if (registry.failed > 0) process.exit(1);
