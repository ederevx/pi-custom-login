/** The provider file in the agent directory, which survives restarts. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { AGENT_DIR_VARIABLE, CONFIG_FILE, type ProviderEntry } from "./provider-config.ts";

export class ProviderStore {
	private readonly path: string;

	constructor(agentDir: string) {
		this.path = join(agentDir, CONFIG_FILE);
	}

	static agentDir(): string {
		return process.env[AGENT_DIR_VARIABLE] ?? join(homedir(), ".pi", "agent");
	}

	all(): Record<string, ProviderEntry> {
		try {
			const stored = JSON.parse(readFileSync(this.path, "utf8")) as { providers?: Record<string, ProviderEntry> };
			return stored.providers ?? {};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return {};
			}
			throw error;
		}
	}

	add(id: string, entry: ProviderEntry): void {
		this.save({ ...this.all(), [id]: entry });
	}

	remove(id: string): void {
		const providers = this.all();
		delete providers[id];
		this.save(providers);
	}

	private save(providers: Record<string, ProviderEntry>): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify({ providers }, null, "\t")}\n`);
	}
}
