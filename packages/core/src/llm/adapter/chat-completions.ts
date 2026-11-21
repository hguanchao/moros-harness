import { parseSse } from "../sse.ts";
import { ProviderError } from "../retry.ts";
import { objectAt, parseJsonObject, stringAt } from "../json.ts";
import { mergeUsage, numberAt, parseToolCall, streamHeaders } from "./shared.ts";
import type { ProtocolAdapter } from "../protocol.ts";
import type { CanonicalMessage, CanonicalPart, ModelResponse, ModelUsage } from "../types.ts";

/** OpenAI Chat Completions 协议适配器。 */
export const chatCompletionsAdapter: ProtocolAdapter = {
	id: "chat-completions",
	endpoint(baseUrl) {
		const base = baseUrl.replace(/\/+$/, "");
		if (base.endsWith("/chat/completions")) return base;
		if (base.endsWith("/v1")) return `${base}/chat/completions`;
		return `${base}/v1/chat/completions`;
	},
	headers(request) {
		const headers = streamHeaders(request);
		if (request.apiKey) headers.set("authorization", `Bearer ${request.apiKey}`);
		return headers;
	},
	body(request) {
		const body: Record<string, unknown> = {
			model: request.model,
			max_tokens: request.maxTokens,
			messages: request.messages.map(toMessage),
			stream: true,
			stream_options: { include_usage: true },
		};
		if (request.tools?.length)
			body.tools = request.tools.map((tool) => ({
				type: "function",
				function: { name: tool.name, description: tool.description, parameters: tool.parameters },
			}));
		if (request.reasoningEffort && request.reasoningEffort !== "off")
			body.reasoning_effort =
				request.reasoningEffort === "minimal"
					? "low"
					: request.reasoningEffort === "max"
						? "high"
						: request.reasoningEffort;
		return body;
	},
	async parse(stream, request, onText, signal, onReasoning) {
		let text = "";
		let reasoningText = "";
		let usage: ModelUsage | undefined;
		let stopReason: ModelResponse["stopReason"] = "end_turn";
		let receivedDone = false;
		let receivedFinishReason = false;
		const tools = new Map<number, { id: string; name: string; json: string }>();
		for await (const event of parseSse(stream, {
			idleTimeoutMs: request.streamIdleTimeoutSec ? request.streamIdleTimeoutSec * 1000 : 0,
			...(signal ? { signal } : {}),
		})) {
			if (event.data === "[DONE]") {
				receivedDone = true;
				break;
			}
			const data = parseJsonObject(event.data, "Chat Completions stream contained invalid JSON");
			usage = mergeUsage(usage, parseUsage(objectAt(data, "usage")));
			const choice = firstObject(data.choices);
			const delta = objectAt(choice, "delta");
			// 推理模型把推理放在 reasoning_content / reasoning / reasoning_text；它与正文分开推送，
			// 不能拼进 text，否则界面会把推理当成回答显示。
			const reasoning =
				stringAt(delta, "reasoning_content") ?? stringAt(delta, "reasoning") ?? stringAt(delta, "reasoning_text");
			if (reasoning) {
				reasoningText += reasoning;
				onReasoning?.(reasoning);
			}
			const piece = stringAt(delta, "content");
			if (piece) {
				text += piece;
				onText?.(piece);
			}
			const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
			for (const callValue of calls) {
				const call = asRecord(callValue);
				const index = numberAt(call, "index");
				let tool = tools.get(index);
				if (!tool) {
					tool = { id: "", name: "", json: "" };
					tools.set(index, tool);
				}
				tool.id += stringAt(call, "id") ?? "";
				const fn = objectAt(call, "function");
				tool.name += stringAt(fn, "name") ?? "";
				tool.json += stringAt(fn, "arguments") ?? "";
			}
			const finishReason = stringAt(choice, "finish_reason");
			if (finishReason) {
				receivedFinishReason = true;
				if (finishReason === "tool_calls" || finishReason === "function_call") stopReason = "tool_use";
				else if (finishReason === "length") stopReason = "max_tokens";
			}
		}
		if (!receivedDone && !receivedFinishReason) {
			throw new ProviderError("Chat Completions stream ended before a completion marker", undefined, undefined, true);
		}
		return {
			text,
			...(reasoningText.length > 0 ? { reasoning: reasoningText } : {}),
			toolCalls: [...tools.values()].map(parseToolCall),
			...(usage ? { usage } : {}),
			stopReason,
		};
	},
};

function toMessage(message: CanonicalMessage): Record<string, unknown> {
	if (message.role === "system") return { role: "system", content: message.content };
	if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
	if (message.role === "assistant") {
		return {
			role: "assistant",
			content: message.content || null,
			...(message.toolCalls?.length
				? {
						tool_calls: message.toolCalls.map((call) => ({
							id: call.id,
							type: "function",
							function: { name: call.name, arguments: JSON.stringify(call.arguments) },
						})),
					}
				: {}),
		};
	}
	return { role: "user", content: typeof message.content === "string" ? message.content : message.content.map(toPart) };
}

function toPart(part: CanonicalPart): Record<string, unknown> {
	return part.type === "text"
		? { type: "text", text: part.text }
		: { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.data}` } };
}

function firstObject(value: unknown): Record<string, unknown> | undefined {
	return Array.isArray(value) && value.length > 0 ? asRecord(value[0]) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseUsage(value: Record<string, unknown> | undefined): ModelUsage | undefined {
	if (!value) return undefined;
	const details = objectAt(value, "prompt_tokens_details");
	const cacheRead = numberAt(details ?? {}, "cached_tokens") || numberAt(value, "prompt_cache_hit_tokens");
	const cacheWrite = numberAt(value, "prompt_cache_miss_tokens");
	return {
		inputTokens: numberAt(value, "prompt_tokens"),
		outputTokens: numberAt(value, "completion_tokens"),
		...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
		...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
	};
}
