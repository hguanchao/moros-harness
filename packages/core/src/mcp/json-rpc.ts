/**
 * JSON-RPC 2.0 的类型与校验。
 *
 * MCP 的三种传输（stdio、Streamable HTTP）在报文层没有区别，都是 JSON-RPC；这里只做
 * 类型收窄与错误定义，不关心报文从哪来。协议校验宁可严格：一条结构不对的报文如果被
 * 放行，后面会在某个字段上炸出更难定位的错误。
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly method: string;
	readonly params?: unknown;
}

export interface JsonRpcNotification {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly params?: unknown;
}

export interface JsonRpcErrorObject {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export interface JsonRpcSuccessResponse {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly result: unknown;
}

export interface JsonRpcErrorResponse {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JSON_RPC_ERROR_CODES = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
} as const;

/** server 返回的 JSON-RPC 错误；message/code 直接来自对端，展示前仍需截断。 */
export class McpError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "McpError";
		this.code = code;
		this.data = data;
	}
}

/** 连接已关闭：进程退出、HTTP 流结束或用户主动关闭。 */
export class McpConnectionClosedError extends Error {
	constructor(message = "MCP connection closed") {
		super(message);
		this.name = "McpConnectionClosedError";
	}
}

/** 请求超时；调用方据此区分「对端慢」与「连接断了」。 */
export class McpTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`MCP request timed out after ${timeoutMs}ms`);
		this.name = "McpTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

/** 请求被中止；name 固定为 AbortError，与项目其它取消路径一致。 */
export class McpAbortError extends Error {
	constructor(message = "MCP request aborted") {
		super(message);
		this.name = "AbortError";
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
	return (
		isRecord(message) &&
		message["jsonrpc"] === "2.0" &&
		isJsonRpcId(message["id"]) &&
		typeof message["method"] === "string"
	);
}

function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
	return (
		isRecord(message) && message["jsonrpc"] === "2.0" && !("id" in message) && typeof message["method"] === "string"
	);
}

function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
	if (!isRecord(message) || message["jsonrpc"] !== "2.0" || !isJsonRpcId(message["id"])) return false;
	if ("result" in message) return !("error" in message);
	if (!("error" in message) || !isRecord(message["error"])) return false;
	return typeof message["error"]["code"] === "number" && typeof message["error"]["message"] === "string";
}

/**
 * 校验并收窄一条从传输层读到的报文。
 * @throws 结构不符合 JSON-RPC 2.0 时抛出 McpError（invalidRequest）。
 */
export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
	if (isJsonRpcRequest(value) || isJsonRpcNotification(value) || isJsonRpcResponse(value)) return value;
	throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid JSON-RPC message");
}

/** 把异常统一成 Error，避免上层处理 `unknown` 时到处重复。 */
export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
