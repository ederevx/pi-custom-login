/** Fails a provider's requests over to one model when the response does not start in time. */

import {
	clampThinkingLevel,
	createAssistantMessageEventStream,
	isModelType,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";

import type { ProviderFallbackConfig } from "./provider-config.ts";

export type FallbackRegistry = Pick<ModelRegistry, "find" | "streamSimple">;

type StreamSimple = NonNullable<ProviderConfig["streamSimple"]>;

export interface FallbackClock {
	setTimeout(callback: () => void, milliseconds: number): unknown;
	clearTimeout(handle: unknown): void;
}

type Phase = "waiting" | "primary" | "fallback" | "finished";
type HeldStart = Extract<AssistantMessageEvent, { type: "start" }>;

interface Request {
	outer: AssistantMessageEventStream;
	primary: AbortController;
	deadline?: unknown;
	listener?: () => void;
	signal?: AbortSignal;
	held?: HeldStart;
	phase: Phase;
	allowFallback: boolean;
}

export class ProviderFallback {
	private readonly guard = new AsyncLocalStorage<boolean>();
	private registry: FallbackRegistry | undefined;

	constructor(
		private readonly clock: FallbackClock = globalThis,
		private readonly streamPrimary: StreamSimple = ProviderFallback.primary,
	) {}

	bindRegistry(registry: FallbackRegistry | undefined): void {
		this.registry = registry;
	}

	stream(
		model: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		settings: ProviderFallbackConfig,
	): AssistantMessageEventStream {
		const request: Request = {
			outer: createAssistantMessageEventStream(),
			primary: new AbortController(),
			phase: "waiting",
			allowFallback: this.guard.getStore() !== true,
			signal: options?.signal,
		};
		if (request.signal?.aborted) {
			this.finish(request, ProviderFallback.aborted(model));
			return request.outer;
		}
		if (request.signal) {
			request.listener = () => this.finish(request, ProviderFallback.aborted(model));
			request.signal.addEventListener("abort", request.listener, { once: true });
		}
		request.deadline = this.clock.setTimeout(
			() => this.expire(request, model, context, options, settings),
			settings.timeoutMs,
		);
		void this.forwardPrimary(request, model, context, options);
		return request.outer;
	}

	private static primary(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		if (model.api !== "openai-completions") {
			throw new Error(`Unsupported primary API: ${model.api}`);
		}
		return openAICompletionsApi().streamSimple(model, context, options);
	}

	private async forwardPrimary(
		request: Request,
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): Promise<void> {
		try {
			const inner = this.streamPrimary(model, context, { ...options, signal: request.primary.signal });
			for await (const event of inner) {
				if (request.phase === "fallback" || request.phase === "finished") {
					continue;
				}
				if (event.type === "start") {
					request.held = event;
					continue;
				}
				if (event.type !== "done" && event.type !== "error") {
					request.phase = "primary";
				}
				this.release(request);
				request.outer.push(event);
				if (event.type === "done" || event.type === "error") {
					this.finish(request);
					return;
				}
			}
			if (request.phase === "fallback" || request.phase === "finished") {
				return;
			}
			this.release(request);
			this.finish(request, ProviderFallback.failed(model, new Error("Provider stream ended without a terminal event")));
		} catch (error) {
			if (request.phase === "fallback" || request.phase === "finished") {
				return;
			}
			this.release(request);
			this.finish(request, ProviderFallback.failed(model, error));
		}
	}

	/** Clears the deadline and flushes a held start before the next forwarded event. */
	private release(request: Request): void {
		this.clear(request);
		if (request.held) {
			request.outer.push(request.held);
			request.held = undefined;
		}
	}

	private expire(
		request: Request,
		model: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		settings: ProviderFallbackConfig,
	): void {
		if (request.phase !== "waiting") {
			return;
		}
		if (request.signal?.aborted) {
			this.finish(request, ProviderFallback.aborted(model));
			return;
		}
		const reason = new Error(`Response-start timeout after ${settings.timeoutMs} ms`);
		if (!request.allowFallback) {
			this.finish(request, ProviderFallback.failed(model, new Error(`${reason.message}; another fallback is not permitted`)));
			return;
		}
		request.phase = "fallback";
		this.clear(request);
		request.held = undefined;
		request.primary.abort();
		if (request.phase !== "fallback") {
			return;
		}
		void this.dispatch(request, model, context, options, settings).catch((error) => {
			this.finish(request, ProviderFallback.failed(model, error));
		});
	}

	private async dispatch(
		request: Request,
		source: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		settings: ProviderFallbackConfig,
	): Promise<void> {
		const target = this.registry?.find(settings.model.provider, settings.model.id);
		if (!target || !ProviderFallback.usable(target, source)) {
			this.finish(request, ProviderFallback.failed(source, new Error(`Response-start timeout after ${settings.timeoutMs} ms; fallback target unavailable`)));
			return;
		}
		const { apiKey: _key, headers: _headers, env: _env, ...rest } = options ?? {};
		const level = clampThinkingLevel(target, options?.reasoning ?? "off");
		const fallbackOptions = {
			...rest,
			signal: options?.signal,
			reasoning: level === "off" ? undefined : level,
			maxTokens: Math.min(options?.maxTokens ?? target.maxTokens, target.maxTokens),
		};
		const inner = this.guard.run(true, () => this.registry!.streamSimple(target, context, fallbackOptions));
		await this.pipe(request, inner, target);
	}

	private async pipe(request: Request, inner: AssistantMessageEventStream, target: Model<Api>): Promise<void> {
		let terminal = false;
		try {
			for await (const event of inner) {
				if (request.phase !== "fallback") {
					return;
				}
				request.outer.push(event);
				terminal ||= event.type === "done" || event.type === "error";
			}
			if (!terminal) {
				throw new Error("Fallback stream ended without a terminal event");
			}
			this.finish(request);
		} catch (error) {
			this.finish(request, ProviderFallback.failed(target, error));
		}
	}

	private clear(request: Request): void {
		if (request.deadline !== undefined) {
			this.clock.clearTimeout(request.deadline);
			request.deadline = undefined;
		}
	}

	private finish(request: Request, error?: AssistantMessage): void {
		if (request.phase === "finished") {
			return;
		}
		request.phase = "finished";
		this.clear(request);
		if (request.signal && request.listener) {
			request.signal.removeEventListener("abort", request.listener);
			request.listener = undefined;
		}
		request.primary.abort();
		if (error) {
			request.outer.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
		}
		request.outer.end();
	}

	private static usable(target: Model<Api>, source: Model<Api>): boolean {
		return isModelType(target, "chat") &&
			target.api !== "pi-virtual" &&
			target.provider !== source.provider &&
			target.contextWindow >= source.contextWindow &&
			source.input.every((modality) => target.input.includes(modality));
	}

	private static aborted(model: Model<Api>): AssistantMessage {
		return ProviderFallback.message(model, "aborted", "Request aborted");
	}

	private static failed(model: Model<Api>, error: unknown): AssistantMessage {
		return ProviderFallback.message(model, "error", error instanceof Error ? error.message : String(error));
	}

	private static message(model: Model<Api>, stopReason: "aborted" | "error", errorMessage: string): AssistantMessage {
		return {
			role: "assistant" as const,
			provider: model.provider,
			api: model.api,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason,
			errorMessage,
			content: [],
			timestamp: Date.now(),
		};
	}
}
