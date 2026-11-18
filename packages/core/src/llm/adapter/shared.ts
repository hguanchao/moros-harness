import { parseJsonObject } from "../json.ts";
import type { ModelRequest, ModelUsage } from "../types.ts";

/** 流式请求的公共头：JSON 请求体与 SSE 响应；凭据头由各协议自行追加。 */
export function streamHeaders(request: ModelRequest): Headers {
	const headers = new Headers(request.headers);
	headers.set("content-type", "application/json");
	headers.set("accept", "text/event-stream");
	return headers;
}

/** 读取 JSON 对象里的有限数值；缺失或类型不符时按 0 计。 */
export function numberAt(value: Record<string, unknown>, key: string): number {
	const child = value[key];
	return typeof child === "number" && Number.isFinite(child) ? child : 0;
}

/** 合并同一响应的多次用量上报：后到的非零值覆盖，缓存字段沿用已有值。 */
export function mergeUsage(previous: ModelUsage | undefined, next: ModelUsage | undefined): ModelUsage | undefined {
	if (!previous) return next;
	if (!next) return previous;
	return {
		inputTokens: next.inputTokens || previous.inputTokens,
		outputTokens: next.outputTokens || previous.outputTokens,
		...(next.cacheReadTokens !== undefined
			? { cacheReadTokens: next.cacheReadTokens }
			: previous.cacheReadTokens !== undefined
				? { cacheReadTokens: previous.cacheReadTokens }
				: {}),
		...(next.cacheWriteTokens !== undefined
			? { cacheWriteTokens: next.cacheWriteTokens }
			: previous.cacheWriteTokens !== undefined
				? { cacheWriteTokens: previous.cacheWriteTokens }
				: {}),
	};
}

/** 把流式累积的工具参数拼成结构化调用；参数不是合法 JSON 时报错。 */
export function parseToolCall(value: { id: string; name: string; json: string }) {
	return {
		id: value.id,
		name: value.name,
		arguments: parseJsonObject(value.json || "{}", `Malformed arguments for tool ${value.name}`),
	};
}
