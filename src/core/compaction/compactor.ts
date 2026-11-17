import type { CanonicalMessage } from "#src/core/llm/types.ts";
import type { EventStore } from "#src/core/session/event-store.ts";

export interface CompactionOptions {
	compactAt: number;
	keepRecent: number;
	summaryTimeoutSec: number;
}

export interface CompactionResult {
	messages: CanonicalMessage[];
	compacted: boolean;
	/** 压缩前的估算 token 数 */
	tokensBefore?: number;
	/** 压缩后的估算 token 数 */
	tokensAfter?: number;
	/** 被摘要替换的消息条数 */
	covered?: number;
	fromSeq?: number;
	toSeq?: number;
	summaryChars?: number;
}

export interface SummaryGenerator {
	summarize(messages: readonly CanonicalMessage[], signal?: AbortSignal): Promise<string>;
}

/** 在请求前按上下文预算压缩旧消息，压缩失败时丢弃最旧消息并保留近期上下文。 */
export class ContextCompactor {
	readonly #options: CompactionOptions;
	readonly #generator: SummaryGenerator;
	readonly #events: EventStore;
	readonly #now: () => number;

	constructor(
		options: CompactionOptions,
		generator: SummaryGenerator,
		events: EventStore,
		now: () => number = Date.now,
	) {
		this.#options = options;
		this.#generator = generator;
		this.#events = events;
		this.#now = now;
	}

	async compact(
		messages: readonly CanonicalMessage[],
		contextWindow: number,
		signal?: AbortSignal,
		eventSeqs: readonly number[] = [],
		options: { readonly force?: boolean } = {},
	): Promise<CompactionResult> {
		const force = options.force === true;
		if ((this.#options.compactAt === 0 && !force) || contextWindow <= 0)
			return { messages: [...messages], compacted: false };
		const currentTokens = estimateTokens(messages);
		if (!force && currentTokens < contextWindow * this.#options.compactAt)
			return { messages: [...messages], compacted: false };

		const keepTokens = Math.max(1, Math.floor(contextWindow * this.#options.keepRecent));
		let firstRecent = messages.length;
		let recentTokens = 0;
		while (firstRecent > 0 && recentTokens < keepTokens) {
			firstRecent -= 1;
			recentTokens += estimateTokens([messages[firstRecent]!]);
		}
		if (firstRecent === 0) return { messages: [...messages], compacted: false };
		// 边界不能切在 assistant(toolCalls) 与它的 tool 结果之间：tool 消息单独留在近期段时，
		// Anthropic 会报「tool_result 没有前置 tool_use」、Chat Completions 会报孤立 tool 消息
		while (firstRecent > 0 && messages[firstRecent]?.role === "tool") firstRecent -= 1;
		if (firstRecent === 0) return { messages: [...messages], compacted: false };

		const oldMessages = messages.slice(0, firstRecent);
		const compactedTokens = estimateTokens(oldMessages);
		const recentMessages = messages.slice(firstRecent);
		let summary: string | undefined;
		try {
			const timeoutSec = this.#options.summaryTimeoutSec;
			summary =
				timeoutSec > 0
					? await withTimeout(
							(summarySignal) => this.#generator.summarize(oldMessages, summarySignal),
							timeoutSec * 1000,
							signal,
						)
					: await this.#generator.summarize(oldMessages, signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown compaction error";
			await this.#events.append({ type: "error", payload: { kind: "compaction", message, recoverable: true } });
		}

		let result: CanonicalMessage[];
		let folded: string;
		if (summary?.trim()) {
			folded = summary.trim();
			result = [{ role: "system", content: `Earlier conversation summary:\n${folded}` }, ...recentMessages];
		} else {
			// 摘要失败时丢弃最旧消息保底；用固定说明作为折叠文本，重放时同样按它折叠
			folded = "Earlier messages were dropped to fit the context window.";
			const retained = [...recentMessages];
			let retainedTokens = recentTokens;
			while (retained.length > 1 && retainedTokens > keepTokens) retainedTokens -= estimateTokens([retained.shift()!]);
			// 二次收窄同样不能从 tool 结果开头
			while (retained.length > 0 && retained[0]?.role === "tool") {
				retained.shift();
				retainedTokens = estimateTokens(retained);
			}
			result = retained;
		}
		const compactedSeqs = eventSeqs.slice(0, firstRecent);
		await this.#events.append({
			type: "compaction.done",
			payload: {
				fromSeq: compactedSeqs[0] ?? 0,
				toSeq: compactedSeqs.at(-1) ?? 0,
				summaryChars: folded.length,
				compactedTokens,
				summary: folded,
			},
		});
		return {
			messages: result,
			compacted: true,
			tokensBefore: currentTokens,
			tokensAfter: estimateTokens(result),
			covered: oldMessages.length,
			fromSeq: compactedSeqs[0] ?? 0,
			toSeq: compactedSeqs.at(-1) ?? 0,
			summaryChars: folded.length,
		};
	}
}

/** 使用字符数近似估算 token 数，避免引入 tokenizer 运行依赖。 */
export function estimateTokens(messages: readonly CanonicalMessage[]): number {
	let chars = 0;
	for (const message of messages) {
		if (message.role === "user" && Array.isArray(message.content)) {
			chars += message.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 256), 0);
		} else if (message.role === "assistant") {
			chars +=
				message.content.length +
				(message.toolCalls?.reduce((sum, call) => sum + call.name.length + JSON.stringify(call.arguments).length, 0) ??
					0);
		} else {
			chars += message.content.length;
		}
	}
	return Math.ceil(chars / 4);
}

function withTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) return Promise.reject(abortError());
	const controller = new AbortController();
	const summarySignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (complete: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			complete();
		};
		const abort = () =>
			finish(() => {
				controller.abort(signal?.reason);
				reject(abortError());
			});
		const timeout = setTimeout(
			() =>
				finish(() => {
					controller.abort(new Error("Compaction summary timed out"));
					reject(new Error("Compaction summary timed out"));
				}),
			timeoutMs,
		);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			operation(summarySignal).then(
				(value) => finish(() => resolve(value)),
				(error: unknown) => finish(() => reject(error)),
			);
		} catch (error) {
			finish(() => reject(error));
		}
	});
}

function abortError(): Error {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}
