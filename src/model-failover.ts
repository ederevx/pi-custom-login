/** Serves a request from a model's stored fallback when its provider fails before answering. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	getApiProvider,
	isContextOverflow,
} from "@earendil-works/pi-ai/compat";

import { FallbackChain } from "./fallback-chain.ts";
import { ProviderStore } from "./provider-store.ts";

export class ModelFailover {
	private readonly store: ProviderStore;
	private readonly pending: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
	private context: ExtensionContext | undefined;
	private running = false;

	constructor(pi: ExtensionAPI, store: ProviderStore) {
		this.store = store;
		// The stream hook receives no context, so pi's own is kept from the session it belongs to.
		pi.on("session_start", (_event, ctx) => {
			this.context = ctx;
		});
		// A notice waits for the run it belongs to: pi has stopped streaming by then.
		pi.on("agent_start", () => {
			this.running = true;
		});
		pi.on("agent_settled", () => {
			this.running = false;
			this.flush();
		});
	}

	/** The API's own stream, as pi would send it, unless this model has a fallback to protect. */
	stream(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
		const api = getApiProvider(model.api);
		if (api === undefined) {
			throw new Error(`No API provider is registered for ${model.api}`);
		}
		const attempt = api.streamSimple(model, context, options);
		if (new FallbackChain(this.store.all()).next(model.provider, model.id) === undefined) {
			return attempt;
		}
		const output = createAssistantMessageEventStream();
		void this.forward(model, attempt, context, options, output).catch(() => output.end());
		return output;
	}

	/** Nothing reaches the caller until the attempt produces content, so a failed attempt is replaced whole. */
	private async forward(
		model: Model<Api>,
		attempt: AssistantMessageEventStream,
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		output: AssistantMessageEventStream,
	): Promise<void> {
		let start: AssistantMessageEvent | undefined;
		let forwarding = false;
		for await (const event of attempt) {
			if (!forwarding && event.type === "start") {
				start = event;
				continue;
			}
			if (!forwarding && event.type === "error" && this.failed(model, event.error, event.reason, options)) {
				await this.failOver(model, event, context, options, output);
				break;
			}
			if (!forwarding && start !== undefined) {
				output.push(start);
			}
			forwarding = true;
			output.push(event);
		}
		output.end();
	}

	/** A cancel, a normal ending, and a context overflow pi compacts on are not provider failures. */
	private failed(model: Model<Api>, message: AssistantMessage, reason: "error" | "aborted", options?: SimpleStreamOptions): boolean {
		return reason === "error" && options?.signal?.aborted !== true && !isContextOverflow(message, model.contextWindow);
	}

	/** Falls back to the original error whenever no fallback can be used, so the stream always ends. */
	private async failOver(
		model: Model<Api>,
		failure: AssistantMessageEvent & { type: "error" },
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		output: AssistantMessageEventStream,
	): Promise<void> {
		// The hop behind this one reports while this frame is still waiting for it, so the
		// place this failure's own notice belongs in is taken before the fallback runs.
		const noticeIndex = this.pending.length;
		try {
			const target = this.target(model);
			if (target === undefined || this.context === undefined) {
				output.push(failure);
				return;
			}
			const attempt = this.context.modelRegistry.streamSimple(target, context, this.options(target, options));
			const served = await this.pipe(attempt, output);
			this.report(model, failure.error, served, noticeIndex);
		} catch (error) {
			output.push(failure);
			this.notice(`${model.provider}/${model.id} failed and its fallback could not run: ${(error as Error).message}`, "warning");
		}
	}

	/** The fallback to use, or undefined once the reason no fallback can run has been reported. */
	private target(model: Model<Api>): Model<Api> | undefined {
		const name = `${model.provider}/${model.id}`;
		const chain = new FallbackChain(this.store.all());
		const hop = chain.next(model.provider, model.id);
		if (hop === undefined) {
			return undefined;
		}
		if (chain.loops(model.provider, model.id)) {
			this.notice(`${name} failed and its fallback chain returns to it; the request was not retried`, "warning");
			return undefined;
		}
		const target = this.context?.modelRegistry.find(hop.provider, hop.model);
		if (target === undefined) {
			this.notice(`${name} failed and its fallback ${hop.provider}/${hop.model} is not in the model list`, "warning");
			return undefined;
		}
		if (!this.context?.modelRegistry.hasConfiguredAuth(target)) {
			this.notice(`${name} failed and its fallback ${hop.provider}/${hop.model} has no credentials`, "warning");
			return undefined;
		}
		return target;
	}

	private async pipe(attempt: AssistantMessageEventStream, output: AssistantMessageEventStream): Promise<AssistantMessage | undefined> {
		let served: AssistantMessage | undefined;
		for await (const event of attempt) {
			output.push(event);
			if (event.type === "done") {
				served = event.message;
			} else if (event.type === "error") {
				served = event.error;
			}
		}
		return served;
	}

	/** Credentials and headers were resolved for the failed provider, so the fallback resolves its own. */
	private options(target: Model<Api>, options?: SimpleStreamOptions): SimpleStreamOptions {
		const { apiKey, headers, env, ...request } = options ?? {};
		void apiKey;
		void headers;
		void env;
		const reasoning = request.reasoning === undefined ? undefined : clampThinkingLevel(target, request.reasoning);
		return {
			...request,
			...(request.maxTokens !== undefined && target.maxTokens > 0 ? { maxTokens: Math.min(request.maxTokens, target.maxTokens) } : {}),
			reasoning: reasoning === "off" ? undefined : reasoning,
		};
	}

	/** The fallback convention: name what served the turn and what it cost. */
	private report(model: Model<Api>, failure: AssistantMessage, served: AssistantMessage | undefined, noticeIndex: number): void {
		if (served === undefined) {
			return;
		}
		const failed = failure.usage.cost.total;
		const spent = failed > 0 ? `, plus $${failed.toFixed(6)} for the failed attempt` : "";
		const outcome = served.stopReason === "error"
			? `failed as well (${served.errorMessage ?? "no error message"})`
			: served.stopReason === "aborted"
				? "was cancelled"
				: `served the turn at $${served.usage.cost.total.toFixed(6)}${spent}`;
		this.notice(`${model.provider}/${model.id} failed (${failure.errorMessage ?? "no error message"}); ${served.provider}/${served.model} ${outcome}`, "info", noticeIndex);
	}

	/** A run's notices wait for its settle, so nothing lands in the middle of streamed output;
	 *  a notice handed a place in that queue keeps it. */
	private notice(message: string, level: "info" | "warning" | "error", index?: number): void {
		if (!this.running) {
			this.context?.ui.notify(message, level);
			return;
		}
		const at = index === undefined ? this.pending.length : Math.min(index, this.pending.length);
		this.pending.splice(at, 0, { message, level });
	}

	private flush(): void {
		for (const notice of this.pending.splice(0)) {
			this.context?.ui.notify(notice.message, notice.level);
		}
	}
}
