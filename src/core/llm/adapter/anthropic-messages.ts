import { parseSse } from "#src/core/llm/sse.ts";
import { ProviderError } from "#src/core/llm/retry.ts";
import { objectAt, parseJsonObject, stringAt } from "#src/core/llm/json.ts";
import { mergeUsage, numberAt, parseToolCall, streamHeaders } from "#src/core/llm/adapter/shared.ts";
import type { ProtocolAdapter } from "#src/core/llm/protocol.ts";
import type { CanonicalMessage, CanonicalPart, ModelRequest, ModelResponse, ModelUsage } from "#src/core/llm/types.ts";

/** Anthropic Messages 协议适配器。 */
export const anthropicMessagesAdapter: ProtocolAdapter = {
	id: "anthropic-messages",
	endpoint(baseUrl) {
		const base = baseUrl.replace(/\/+$/, "");
		return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
	},
	headers(request) {
		const headers = streamHeaders(request);
		headers.set("x-api-key", request.apiKey);
		headers.set("anthropic-version", "2023-06-01");
		return headers;
	},
	body(request) {
		// 系统消息可能不止一条：压缩摘要是后插入的 system 消息，只取第一条会把摘要丢掉
		const system = request.messages
			.filter((message) => message.role === "system")
			.map((message) => message.content)
			.join("\n\n");
		const body: Record<string, unknown> = {
			model: request.model,
			max_tokens: request.maxTokens,
			messages: request.messages.filter((message) => message.role !== "system").map(toMessage),
			stream: true,
		};
		if (system) body.system = system;
		if (request.tools?.length)
			body.tools = request.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: tool.parameters,
			}));
		if (request.reasoningEffort && request.reasoningEffort !== "off") {
			body.thinking = { type: "enabled", budget_tokens: reasoningBudget(request.reasoningEffort, request.maxTokens) };
		}
		return body;
	},
	async parse(stream, request, onText, signal, onReasoning) {
		let text = "";
		let usage: ModelUsage | undefined;
		let stopReason: ModelResponse["stopReason"] = "end_turn";
		const tools = new Map<number, { id: string; name: string; json: string }>();
		for await (const event of parseSse(stream, {
			idleTimeoutMs: request.streamIdleTimeoutSec ? request.streamIdleTimeoutSec * 1000 : 0,
			...(signal ? { signal } : {}),
		})) {
			const data = parseJsonObject(event.data, "Anthropic stream contained invalid JSON");
			if (event.event === "message_start")
				usage = parseUsage(objectAt(objectAt(data, "message"), "usage"), "input_tokens", "output_tokens");
			if (event.event === "content_block_start") {
				const block = objectAt(data, "content_block");
				if (block && stringAt(block, "type") === "tool_use") {
					tools.set(numberAt(data, "index"), {
						id: stringAt(block, "id") ?? "",
						name: stringAt(block, "name") ?? "",
						json: "",
					});
				}
			}
			if (event.event === "content_block_delta") {
				const delta = objectAt(data, "delta");
				if (stringAt(delta, "type") === "thinking_delta") {
					const thinking = stringAt(delta, "thinking") ?? "";
					if (thinking) onReasoning?.(thinking);
				} else if (stringAt(delta, "type") === "text_delta") {
					const piece = stringAt(delta, "text") ?? "";
					text += piece;
					onText?.(piece);
				} else if (stringAt(delta, "type") === "input_json_delta") {
					const tool = tools.get(numberAt(data, "index"));
					if (tool) tool.json += stringAt(delta, "partial_json") ?? "";
				}
			}
			if (event.event === "message_delta") {
				const delta = objectAt(data, "delta");
				const reason = stringAt(delta, "stop_reason");
				stopReason = reason === "tool_use" ? "tool_use" : reason === "max_tokens" ? "max_tokens" : "end_turn";
				usage = mergeUsage(usage, parseUsage(objectAt(data, "usage"), "input_tokens", "output_tokens"));
			}
			if (event.event === "error") {
				const error = objectAt(data, "error");
				throw new ProviderError(stringAt(error, "message") ?? "Anthropic stream error");
			}
		}
		return { text, toolCalls: [...tools.values()].map(parseToolCall), ...(usage ? { usage } : {}), stopReason };
	},
};

function toMessage(message: Exclude<CanonicalMessage, { role: "system" }>): Record<string, unknown> {
	if (message.role === "tool")
		return {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: message.toolCallId,
					content: message.content,
					is_error: message.isError ?? false,
				},
			],
		};
	if (message.role === "assistant") {
		const content: Record<string, unknown>[] = [];
		if (message.content) content.push({ type: "text", text: message.content });
		for (const call of message.toolCalls ?? [])
			content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
		return { role: "assistant", content };
	}
	return {
		role: "user",
		content:
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content.map(toPart),
	};
}

function toPart(part: CanonicalPart): Record<string, unknown> {
	return part.type === "text"
		? { type: "text", text: part.text }
		: { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } };
}

function parseUsage(
	value: Record<string, unknown> | undefined,
	inputKey: string,
	outputKey: string,
): ModelUsage | undefined {
	if (!value) return undefined;
	const cacheRead = numberAt(value, "cache_read_input_tokens");
	const cacheWrite = numberAt(value, "cache_creation_input_tokens");
	return {
		inputTokens: numberAt(value, inputKey) + cacheRead + cacheWrite,
		outputTokens: numberAt(value, outputKey),
		...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
		...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
	};
}

function reasoningBudget(effort: NonNullable<ModelRequest["reasoningEffort"]>, maxTokens: number): number {
	const ratios: Record<Exclude<typeof effort, "off">, number> = {
		minimal: 0.05,
		low: 0.1,
		medium: 0.2,
		high: 0.35,
		max: 0.5,
	};
	const normalizedEffort = effort === "off" ? "minimal" : effort;
	return Math.max(1, Math.min(maxTokens - 1, Math.floor(maxTokens * ratios[normalizedEffort])));
}
