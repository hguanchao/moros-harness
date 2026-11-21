import { anthropicMessagesAdapter } from "./adapter/anthropic-messages.ts";
import { chatCompletionsAdapter } from "./adapter/chat-completions.ts";
import { HttpTransport } from "./http.ts";
import { validateMessages } from "./messages.ts";
import { withRetry } from "./retry.ts";
import { responsesAdapter } from "./adapter/responses.ts";
import type { ProtocolAdapter } from "./protocol.ts";
import type { LlmClientOptions, ModelRequest, ModelResponse, RetryOptions } from "./types.ts";

/** 单次模型请求的取消、重试和流式文本回调。 */
export interface CompleteOptions {
	signal?: AbortSignal;
	retry?: Partial<RetryOptions>;
	onText?: (text: string) => void;
	/** 推理模型的推理增量；与正文分开推送，不进入最终文本。 */
	onReasoning?: (text: string) => void;
	onRetry?: () => void;
}

function isIncompleteStreamError(error: unknown): boolean {
	return error instanceof Error && /stream (?:idle timeout|ended before)/i.test(error.message);
}

/**
 * 通过协议注册表协调消息校验、HTTP 传输与重试。
 *
 * 协议路径、载荷形状和流解析都交给 `ProtocolAdapter`，这里只管编排：选适配器、套重试、
 * 把流式片段转成调用方要的增量。协议之间的差异不应泄漏到这一层。
 */
export class LlmClient {
	readonly #transport: HttpTransport;
	readonly #adapters: ReadonlyMap<ModelRequest["api"], ProtocolAdapter>;
	readonly #runtime: LlmClientOptions;
	readonly #defaultRetry: RetryOptions;

	constructor(options: LlmClientOptions & { retry?: Partial<RetryOptions> } = {}) {
		this.#transport = new HttpTransport({
			...(options.fetch ? { fetch: options.fetch } : {}),
			...(options.env ? { env: options.env } : {}),
		});
		this.#adapters = new Map([
			[anthropicMessagesAdapter.id, anthropicMessagesAdapter],
			[chatCompletionsAdapter.id, chatCompletionsAdapter],
			[responsesAdapter.id, responsesAdapter],
		]);
		this.#runtime = options;
		this.#defaultRetry = {
			maxRetries: options.retry?.maxRetries ?? 3,
			maxDelayMs: options.retry?.maxDelayMs ?? 60_000,
		};
	}

	/** 完成模型响应；文本增量可选地经回调返回，最终结果包含完整规范消息数据。 */
	async complete(request: ModelRequest, options: CompleteOptions = {}): Promise<ModelResponse> {
		validateMessages(request.messages);
		const adapter = this.#adapters.get(request.api);
		if (!adapter) throw new Error(`Unsupported LLM protocol: ${request.api}`);
		const retry: RetryOptions = {
			maxRetries: options.retry?.maxRetries ?? this.#defaultRetry.maxRetries,
			maxDelayMs: options.retry?.maxDelayMs ?? this.#defaultRetry.maxDelayMs,
		};
		if (options.signal) retry.signal = options.signal;
		retry.onRetry = (error) => {
			if (isIncompleteStreamError(error)) options.onRetry?.();
		};
		return withRetry(
			async () => {
				const response = await this.#transport.withResponse(request, adapter, options.signal, (stream) =>
					adapter.parse(stream, request, options.onText, options.signal, options.onReasoning),
				);
				return response;
			},
			retry,
			this.#runtime,
		);
	}
}
