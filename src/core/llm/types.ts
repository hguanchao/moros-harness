/** 模型请求支持的推理强度级别。 */
export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "max";
/** 模型输入支持的图片 MIME 类型。 */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
/** 规范消息中的文本或图片部件。 */
export type CanonicalPart = { type: "text"; text: string } | { type: "image"; mediaType: ImageMediaType; data: string };
/** 与具体供应商协议无关的规范消息。 */
export type CanonicalMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string | CanonicalPart[] }
	| { role: "assistant"; content: string; toolCalls?: CanonicalToolCall[] }
	| { role: "tool"; toolCallId: string; content: string; isError?: boolean };
export interface CanonicalToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
export interface ModelRequest {
	provider: string;
	model: string;
	api: "anthropic-messages" | "chat-completions" | "responses";
	baseUrl: string;
	httpProxy?: string;
	apiKey: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	streamIdleTimeoutSec?: number;
	maxTokens: number;
	reasoningEffort?: ReasoningEffort;
	messages: readonly CanonicalMessage[];
	tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}
export interface ModelUsage {
	/** 总输入 token；包含命中缓存的部分。 */
	inputTokens: number;
	outputTokens: number;
	/** 从提示缓存读取的 token 数；provider 未报告时缺省。 */
	cacheReadTokens?: number;
	/** 写入提示缓存的 token 数；provider 未报告时缺省。 */
	cacheWriteTokens?: number;
}
export interface ModelResponse {
	text: string;
	toolCalls: CanonicalToolCall[];
	usage?: ModelUsage;
	stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
}
export interface LlmClientOptions {
	fetch?: typeof fetch;
	/** HTTP 代理解析使用的环境变量来源。 */
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	random?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export interface RetryOptions {
	maxRetries: number;
	maxDelayMs: number;
	signal?: AbortSignal;
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}
