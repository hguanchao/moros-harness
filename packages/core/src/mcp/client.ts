import {
	isRecord,
	isJsonRpcId,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
	type JsonRpcResponse,
	McpAbortError,
	McpConnectionClosedError,
	McpError,
	McpTimeoutError,
	JSON_RPC_ERROR_CODES,
	toError,
} from "./json-rpc.ts";
import { normalizeMcpInputSchema } from "./input-schema.ts";
import type { McpTransport } from "./transport.ts";
import type { McpCallResult, McpToolInfo } from "./types.ts";

/** 控制请求（握手、列工具）的固定短超时。 */
export const CONTROL_TIMEOUT_MS = 15_000;
/** 工具调用没配置时限时的默认值。 */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** 当前支持的最新协议版本；与 pi 的实现保持一致。 */
export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** list 系列方法的最大翻页数；防止对端用重复 cursor 把客户端拖死。 */
const MAX_LIST_PAGES = 100;

export interface McpRequestOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly onProgress?: (progress: unknown) => void;
}

export interface McpClientOptions {
	readonly transport: McpTransport;
	readonly clientName: string;
	readonly version: string;
	readonly controlTimeoutMs?: number;
	readonly callTimeoutMs: number;
	/** 工作区根；声明 roots 能力并回应 server 的 roots/list。 */
	readonly roots?: readonly { readonly uri: string; readonly name: string }[];
	/** 服务端通知（无 id 的报文）；`tools/list_changed` 由管理器关心。 */
	readonly onNotification?: (method: string, params: unknown) => void;
	/** 传输层错误；不会自动终止连接，连接关闭会另行派发。 */
	readonly onError?: (error: Error) => void;
}

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly cancellable: boolean;
	readonly onProgress: ((progress: unknown) => void) | undefined;
	readonly onAbort: () => void;
	/** 本次请求的原始时限；进度通知重置时仍用它，不能被默认值悄悄放宽。 */
	readonly timeoutMs: number;
	/** 中止传输层尚未完成的发送/网络读取；请求结束即 abort。 */
	readonly sendController: AbortController;
	timer: ReturnType<typeof setTimeout> | undefined;
	signal: AbortSignal | undefined;
	progressToken: JsonRpcId | undefined;
}

type ClientState = "idle" | "connecting" | "connected" | "closed";

/**
 * MCP 客户端：把 JSON-RPC 的一问一答对上号。
 *
 * 传输层只管搬报文；这里负责请求 id、超时、取消、服务端反向请求，以及 tools 相关的
 * 协议细节。连接一旦关闭，所有在途请求都以 McpConnectionClosedError 收尾，不留下永不
 * 兑现的 Promise。
 */
export class McpClient {
	readonly #options: McpClientOptions;
	readonly #pending = new Map<JsonRpcId, Pending>();
	#nextId = 1;
	#state: ClientState = "idle";
	#disposers: (() => void)[] = [];
	#serverCapabilities: Record<string, unknown> | undefined;
	#instructions: string | undefined;

	constructor(options: McpClientOptions) {
		this.#options = options;
	}

	get state(): ClientState {
		return this.#state;
	}

	/** server 在 initialize 里声明的能力；未连接时为 undefined。 */
	get serverCapabilities(): Record<string, unknown> | undefined {
		return this.#serverCapabilities;
	}

	/** server 在 initialize 里给出的使用说明；没有就是 undefined。 */
	get instructions(): string | undefined {
		return this.#instructions;
	}

	/** 握手：initialize → notifications/initialized。 */
	async connect(): Promise<void> {
		if (this.#state !== "idle") throw new Error(`Cannot connect MCP client in ${this.#state} state`);
		this.#state = "connecting";
		const transport = this.#options.transport;
		this.#disposers = [
			transport.onMessage((message) => this.#handleMessage(message)),
			transport.onClose(() => this.#handleTransportClose()),
			transport.onError((error) => this.#options.onError?.(error)),
		];

		try {
			await transport.start();
			const result = await this.#request(
				"initialize",
				{
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: this.#options.roots ? { roots: {} } : {},
					clientInfo: { name: this.#options.clientName, version: this.#options.version },
				},
				this.#controlTimeoutMs,
				{},
				true,
			);
			if (!isRecord(result) || typeof result["protocolVersion"] !== "string") {
				throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP initialize result");
			}
			const version = result["protocolVersion"];
			if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
				throw new Error(`MCP server selected unsupported protocol version ${version}`);
			}
			this.#serverCapabilities = isRecord(result["capabilities"]) ? result["capabilities"] : {};
			this.#instructions = typeof result["instructions"] === "string" ? result["instructions"] : undefined;
			transport.setProtocolVersion?.(version);
			await this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
			this.#state = "connected";
		} catch (error) {
			await this.close().catch(() => undefined);
			throw error;
		}
	}

	/**
	 * 列出远端工具，按 cursor 翻完所有页。
	 * @throws 对端返回的结构不符合协议、cursor 重复或超过页数上限时抛出。
	 */
	async listTools(options: McpRequestOptions = {}): Promise<readonly McpToolInfo[]> {
		const tools: McpToolInfo[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
			const result = await this.#request(
				"tools/list",
				cursor === undefined ? undefined : { cursor },
				this.#controlTimeoutMs,
				options,
			);
			if (!isRecord(result) || !Array.isArray(result["tools"])) {
				throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP tools/list result");
			}
			for (const item of result["tools"]) {
				tools.push(readTool(item));
			}
			const next = result["nextCursor"];
			if (next === undefined || next === null || next === "") return tools;
			if (typeof next !== "string") {
				throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP tools/list cursor");
			}
			if (cursors.has(next)) {
				throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, `MCP tools/list repeated cursor ${next}`);
			}
			cursors.add(next);
			cursor = next;
		}
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, `MCP tools/list exceeded ${MAX_LIST_PAGES} pages`);
	}

	/** 调用远端工具；`isError` 由结果表达，不作为协议错误抛出。 */
	async callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions = {}): Promise<McpCallResult> {
		const result = await this.#request(
			"tools/call",
			{ name, arguments: args },
			options.timeoutMs ?? this.#options.callTimeoutMs,
			options,
		);
		return readCallResult(result);
	}

	/**
	 * 健康检查：优先 ping；server 不实现 ping 时退回列一次工具。
	 * @throws ping 与列工具都失败时抛出最后一次错误。
	 */
	async ping(options: McpRequestOptions = {}): Promise<void> {
		try {
			await this.#request("ping", undefined, this.#controlTimeoutMs, options);
		} catch {
			await this.listTools({ ...options, timeoutMs: this.#controlTimeoutMs });
		}
	}

	/** 关闭连接并拒绝所有在途请求；可重复调用。 */
	async close(): Promise<void> {
		if (this.#state === "closed") return;
		this.#state = "closed";
		for (const dispose of this.#disposers.splice(0)) dispose();
		this.#failAll(new McpConnectionClosedError());
		await this.#options.transport.close().catch(() => undefined);
	}

	get #controlTimeoutMs(): number {
		return this.#options.controlTimeoutMs ?? CONTROL_TIMEOUT_MS;
	}

	#request(
		method: string,
		params: Record<string, unknown> | undefined,
		timeoutMs: number,
		options: McpRequestOptions,
		allowConnecting = false,
	): Promise<unknown> {
		if (this.#state === "closed" || (this.#state !== "connected" && !allowConnecting)) {
			return Promise.reject(new McpConnectionClosedError(`MCP client is ${this.#state}`));
		}
		if (options.signal?.aborted) return Promise.reject(new McpAbortError());

		const id = this.#nextId;
		this.#nextId += 1;
		const progressToken = options.onProgress === undefined ? undefined : id;
		const requestParams =
			progressToken === undefined
				? params
				: {
						...(params ?? {}),
						_meta: {
							...(isRecord(params?._meta) ? params._meta : {}),
							progressToken,
						},
					};
		const message: JsonRpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			...(requestParams === undefined ? {} : { params: requestParams }),
		};

		return new Promise<unknown>((resolve, reject) => {
			const sendController = new AbortController();
			const entry: Pending = {
				resolve,
				reject,
				// 规范禁止取消 initialize；其余请求中止时通知对端，别让它白干
				cancellable: method !== "initialize",
				onProgress: options.onProgress,
				progressToken,
				timeoutMs,
				sendController,
				timer: undefined,
				signal: options.signal,
				onAbort: () => {
					this.#cancelPending(id, new McpAbortError(), String(options.signal?.reason ?? "aborted"));
				},
			};
			this.#pending.set(id, entry);
			this.#armTimeout(id, entry);
			options.signal?.addEventListener("abort", entry.onAbort, { once: true });
			void this.#send(message, sendController.signal).catch((error: unknown) => {
				this.#cancelPending(id, toError(error), undefined);
			});
		});
	}

	#armTimeout(id: JsonRpcId, entry: Pending): void {
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		if (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs <= 0) return;
		entry.timer = setTimeout(() => {
			this.#cancelPending(id, new McpTimeoutError(entry.timeoutMs), "Request timed out");
		}, entry.timeoutMs);
	}

	#cancelPending(id: JsonRpcId, error: Error, reason: string | undefined): void {
		const entry = this.#pending.get(id);
		if (!entry) return;
		this.#removePending(id, entry);
		entry.reject(error);
		if (entry.cancellable && reason !== undefined) {
			void this.#send({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: id, reason },
			}).catch(() => undefined);
		}
	}

	#removePending(id: JsonRpcId, entry: Pending): void {
		this.#pending.delete(id);
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		entry.signal?.removeEventListener("abort", entry.onAbort);
		entry.sendController.abort();
	}

	#handleMessage(message: JsonRpcMessage): void {
		if ("id" in message && !("method" in message)) {
			this.#handleResponse(message);
			return;
		}
		if ("method" in message && "id" in message) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}
		if ("method" in message) {
			this.#handleNotification(message.method, message.params);
		}
	}

	#handleResponse(message: JsonRpcResponse): void {
		const entry = this.#pending.get(message.id);
		if (!entry) return;
		this.#removePending(message.id, entry);
		if ("error" in message) {
			entry.reject(new McpError(message.error.code, message.error.message, message.error.data));
			return;
		}
		entry.resolve(message.result);
	}

	/** 回应服务端反向请求；不声明/不实现的能力明确回 methodNotFound，别让对方一直等。 */
	async #handleServerRequest(message: JsonRpcRequest): Promise<void> {
		try {
			if (message.method === "ping") {
				await this.#send({ jsonrpc: "2.0", id: message.id, result: {} });
				return;
			}
			if (message.method === "roots/list" && this.#options.roots !== undefined) {
				await this.#send({ jsonrpc: "2.0", id: message.id, result: { roots: this.#options.roots } });
				return;
			}
			await this.#send({
				jsonrpc: "2.0",
				id: message.id,
				error: {
					code: JSON_RPC_ERROR_CODES.methodNotFound,
					message: `This client does not support ${message.method}`,
				},
			});
		} catch (error) {
			this.#options.onError?.(toError(error));
		}
	}

	#handleNotification(method: string, params: unknown): void {
		if (method === "notifications/progress" && isRecord(params) && isJsonRpcId(params["progressToken"])) {
			const entry = this.#pending.get(params["progressToken"]);
			if (entry) {
				// 进度通知证明对端还活着；按原时限重新计时，避免长任务被误杀
				this.#armTimeout(params["progressToken"], entry);
				try {
					entry.onProgress?.(params);
				} catch (error) {
					this.#options.onError?.(toError(error));
				}
			}
		}
		this.#options.onNotification?.(method, params);
	}

	async #send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
		if (this.#state === "closed") throw new McpConnectionClosedError();
		await this.#options.transport.send(message, signal ? { signal } : {});
	}

	#handleTransportClose(): void {
		if (this.#state === "closed") return;
		this.#state = "closed";
		this.#failAll(new McpConnectionClosedError());
	}

	#failAll(error: Error): void {
		const waiting = [...this.#pending.entries()];
		this.#pending.clear();
		for (const [, entry] of waiting) {
			if (entry.timer !== undefined) clearTimeout(entry.timer);
			entry.signal?.removeEventListener("abort", entry.onAbort);
			entry.reject(error);
		}
	}
}

function readTool(value: unknown): McpToolInfo {
	if (!isRecord(value) || typeof value["name"] !== "string") {
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid tool entry in MCP tools/list result");
	}
	const rawSchema = value["inputSchema"];
	return {
		name: value["name"],
		description: typeof value["description"] === "string" ? value["description"] : "",
		inputSchema: normalizeMcpInputSchema(isRecord(rawSchema) ? rawSchema : {}),
	};
}

/**
 * 把 `tools/call` 结果转成模型可读文本。
 *
 * 文本原样拼接；图片、资源这类块当前无法内联进工具结果，给出占位说明。没有 content 的
 * server 用 structuredContent 兜底（部分实现只返回结构化数据）。
 */
function readCallResult(result: unknown): McpCallResult {
	if (!isRecord(result)) return { content: "The MCP server returned no result.", isError: true };
	const isError = result["isError"] === true;
	const blocks = Array.isArray(result["content"]) ? result["content"] : [];
	const parts: string[] = [];
	for (const block of blocks) {
		if (!isRecord(block)) continue;
		const type = typeof block["type"] === "string" ? block["type"] : "unknown";
		if (type === "text" && typeof block["text"] === "string") {
			parts.push(block["text"]);
			continue;
		}
		if (type === "image") {
			const mime = typeof block["mimeType"] === "string" ? block["mimeType"] : "image";
			const bytes = typeof block["data"] === "string" ? Buffer.byteLength(block["data"], "base64") : 0;
			parts.push(`[image content (${mime}, ${bytes} bytes) is not shown here]`);
			continue;
		}
		if (type === "resource") {
			const resource = isRecord(block["resource"]) ? block["resource"] : {};
			const uri = typeof resource["uri"] === "string" ? resource["uri"] : "unknown";
			if (typeof resource["text"] === "string") {
				parts.push(`[resource ${uri}]\n${resource["text"]}`);
			} else {
				const mime = typeof resource["mimeType"] === "string" ? resource["mimeType"] : "unknown type";
				const bytes = typeof resource["blob"] === "string" ? Buffer.byteLength(resource["blob"], "base64") : 0;
				parts.push(`[binary resource ${uri} (${mime}, ${bytes} bytes) is not shown here]`);
			}
			continue;
		}
		if (type === "resource_link") {
			const uri = typeof block["uri"] === "string" ? block["uri"] : "unknown";
			parts.push(`[resource link ${uri}]`);
			continue;
		}
		parts.push(`[${type} content is not shown here]`);
	}

	if (parts.length === 0 && result["structuredContent"] !== undefined) {
		parts.push(JSON.stringify(result["structuredContent"], null, 2));
	}
	if (parts.length === 0) {
		parts.push(isError ? "The MCP server reported a failure without details." : "The MCP server returned no content.");
	}
	return { content: parts.join("\n\n"), isError };
}
