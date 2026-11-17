import { parseSse } from "#src/core/llm/sse.ts";
import { ProviderError } from "#src/core/llm/retry.ts";
import { objectAt, parseJsonObject, stringAt } from "#src/core/llm/json.ts";
import { numberAt, parseToolCall, streamHeaders } from "#src/core/llm/adapter/shared.ts";
import type { ProtocolAdapter } from "#src/core/llm/protocol.ts";
import type { CanonicalMessage, CanonicalPart, ModelResponse, ModelUsage } from "#src/core/llm/types.ts";

/** OpenAI Responses 协议适配器。 */
export const responsesAdapter: ProtocolAdapter = {
	id: "responses",
	endpoint(baseUrl) {
		const base = baseUrl.replace(/\/+$/, "");
		return base.endsWith("/responses") ? base : base.endsWith("/v1") ? `${base}/responses` : `${base}/v1/responses`;
	},
	headers(request) {
		const headers = streamHeaders(request);
		if (request.apiKey) headers.set("authorization", `Bearer ${request.apiKey}`);
		return headers;
	},
	body(request) {
		// 同 Anthropic：压缩摘要也是 system 消息，合并全部而不是只取第一条
		const system = request.messages
			.filter((message) => message.role === "system")
			.map((message) => message.content)
			.join("\n\n");
		const body: Record<string, unknown> = {
			model: request.model,
			max_output_tokens: request.maxTokens,
			input: request.messages.filter((message) => message.role !== "system").map(toInput),
			stream: true,
		};
		if (system) body.instructions = system;
		if (request.tools?.length)
			body.tools = request.tools.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				strict: false,
			}));
		if (request.reasoningEffort && request.reasoningEffort !== "off") {
			const effort =
				request.reasoningEffort === "minimal"
					? "low"
					: request.reasoningEffort === "max"
						? "high"
						: request.reasoningEffort;
			body.reasoning = { effort };
		}
		return body;
	},
	async parse(stream, request, onText, signal, onReasoning) {
		let text = "";
		let usage: ModelUsage | undefined;
		let stopReason: ModelResponse["stopReason"] = "end_turn";
		const tools = new Map<string, { id: string; name: string; json: string }>();
		for await (const event of parseSse(stream, {
			idleTimeoutMs: request.streamIdleTimeoutSec ? request.streamIdleTimeoutSec * 1000 : 0,
			...(signal ? { signal } : {}),
		})) {
			const data = parseJsonObject(event.data, "Responses stream contained invalid JSON");
			const type = event.event ?? stringAt(data, "type") ?? "";
			if (type === "response.output_text.delta") {
				const piece = stringAt(data, "delta") ?? "";
				text += piece;
				onText?.(piece);
			} else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
				const piece = stringAt(data, "delta") ?? "";
				if (piece) onReasoning?.(piece);
			} else if (type === "response.reasoning_summary_part.done") {
				// 摘要分段之间补一个空行，连续思考不会粘成一段
				onReasoning?.("\n\n");
			} else if (type === "response.output_item.added") {
				const item = objectAt(data, "item");
				if (stringAt(item, "type") === "function_call") {
					const index = String(numberAt(data, "output_index"));
					tools.set(index, {
						id: stringAt(item, "call_id") ?? "",
						name: stringAt(item, "name") ?? "",
						json: stringAt(item, "arguments") ?? "",
					});
				}
			} else if (type === "response.function_call_arguments.delta") {
				const tool = tools.get(String(numberAt(data, "output_index")));
				if (tool) tool.json += stringAt(data, "delta") ?? "";
			} else if (type === "response.completed") {
				const response = objectAt(data, "response");
				usage = parseUsage(objectAt(response, "usage"));
				const status = stringAt(response, "status");
				stopReason = status === "incomplete" ? "max_tokens" : tools.size ? "tool_use" : "end_turn";
				addFinalOutput(response, tools, (piece) => {
					if (text.length === 0) text += piece;
				});
			} else if (type === "response.failed" || type === "error") {
				const error = objectAt(data, "error");
				throw new ProviderError(stringAt(error, "message") ?? stringAt(data, "message") ?? "Responses stream error");
			}
		}
		return { text, toolCalls: [...tools.values()].map(parseToolCall), ...(usage ? { usage } : {}), stopReason };
	},
};

function toInput(message: Exclude<CanonicalMessage, { role: "system" }>): Record<string, unknown> {
	if (message.role === "tool")
		return { type: "function_call_output", call_id: message.toolCallId, output: message.content };
	if (message.role === "assistant") {
		const content: Record<string, unknown>[] = [];
		if (message.content)
			content.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: message.content }] });
		for (const call of message.toolCalls ?? [])
			content.push({
				type: "function_call",
				call_id: call.id,
				name: call.name,
				arguments: JSON.stringify(call.arguments),
			});
		return { role: "assistant", content };
	}
	return {
		role: "user",
		content:
			typeof message.content === "string"
				? [{ type: "input_text", text: message.content }]
				: message.content.map(toPart),
	};
}

function toPart(part: CanonicalPart): Record<string, unknown> {
	return part.type === "text"
		? { type: "input_text", text: part.text }
		: { type: "input_image", image_url: `data:${part.mediaType};base64,${part.data}` };
}

function addFinalOutput(
	response: Record<string, unknown> | undefined,
	tools: Map<string, { id: string; name: string; json: string }>,
	setText: (text: string) => void,
): void {
	const output = response?.output;
	if (!Array.isArray(output)) return;
	for (const value of output) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const item = value as Record<string, unknown>;
		if (item.type === "function_call") {
			const key = String(item.id ?? item.call_id ?? "");
			const existing = [...tools.values()].some(
				(call) => call.id === (stringAt(item, "call_id") ?? stringAt(item, "id")),
			);
			if (!tools.has(key) && !existing)
				tools.set(key, {
					id: stringAt(item, "call_id") ?? stringAt(item, "id") ?? "",
					name: stringAt(item, "name") ?? "",
					json: stringAt(item, "arguments") ?? "",
				});
		} else if (item.type === "message" && Array.isArray(item.content)) {
			for (const valuePart of item.content) {
				if (valuePart && typeof valuePart === "object" && !Array.isArray(valuePart)) {
					const part = valuePart as Record<string, unknown>;
					if (part.type === "output_text" && typeof part.text === "string") setText(part.text);
				}
			}
		}
	}
}

function parseUsage(value: Record<string, unknown> | undefined): ModelUsage | undefined {
	if (!value) return undefined;
	const details = objectAt(value, "input_tokens_details");
	const cacheRead = numberAt(details ?? {}, "cached_tokens");
	return {
		inputTokens: numberAt(value, "input_tokens"),
		outputTokens: numberAt(value, "output_tokens"),
		...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
	};
}
