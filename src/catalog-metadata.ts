/** The per-model metadata some endpoints report beside the OpenAI-shaped entries. */
export class CatalogMetadata {
	private readonly entries = new Map<string, Record<string, unknown>>();
	private readonly label: string;

	constructor(value: unknown, label: string) {
		this.label = label;
		if (value === undefined) {
			return;
		}
		if (!Array.isArray(value)) {
			throw this.failure("has a malformed metadata list");
		}
		for (const entry of value) {
			const record = this.record(entry);
			const slug = this.slug(record);
			if (this.entries.has(slug)) {
				throw this.failure(`has a duplicate metadata slug ${slug}`);
			}
			this.entries.set(slug, record);
		}
	}

	for(slug: string): Record<string, unknown> | undefined {
		return this.entries.get(slug);
	}

	private record(entry: unknown): Record<string, unknown> {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw this.failure("has a malformed metadata entry");
		}
		return entry as Record<string, unknown>;
	}

	private slug(record: Record<string, unknown>): string {
		const slug = record.slug;
		if (typeof slug !== "string" || slug.trim() === "") {
			throw this.failure("has a metadata entry without a slug");
		}
		return slug;
	}

	private failure(problem: string): Error {
		return new Error(`${this.label}: model catalog ${problem}`);
	}
}
