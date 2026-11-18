import { parseSse } from "#src/core/llm/sse.ts";
import {
	McpAbortError,
	McpConnectionClosedError,
	parseJsonRpcMessage,
	type JsonRpcMessage,
} from "#src/core/mcp/json-rpc.ts";
import { TransportEvents, type McpTransport } from "#src/core/mcp/transport.ts";

/** HTTP 状态错误；body 只保留片段，避免把整页错误塞进状态行。 */
export class McpHttpError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, message: string, body = "") {
		super(message);
		this.name = "McpHttpError";
		this.status = status;
		this.body = body;
	}
}

const ERROR_BODY_CHARS = 500;
const GET_STREAM_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
/** GET 流被这些状态明确拒绝时不再重试：服务端就是没提供 server→client 通道。 */
const GET_STREAM_UNSUPPORTED = new Set([404, 405, 406, 501]);

export interface StreamableHttpTransportOptions {
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly fetch?: typeof fetch;
	/** 是否在初始化后打开 server→client 的 GET 事件流；默认 true。 */
	readonly openGetStream?: boolean;
}

/**
 * MCP Streamable HTTP 传输。
 *
 * 客户端消息用 POST；响应可能是单个 JSON，也可能是一条 SSE 流（服务端在干活过程中把
 * 进度/结果推回来）。初始化完成后另开一条 GET 流接收服务端主动通知；部分服务端不提供
 * 这条流，遇到 404/405/406/501 就安静停止，不影响工具调用。
 */
export class StreamableHttpTransport extends TransportEvents implements McpTransport {
	readonly #options: StreamableHttpTransportOptions;
	readonly #fetch: typeof fetch;
	readonly #closeController = new AbortController();
	#sessionId: string | undefined;
	#protocolVersion: string | undefined;
	#started = false;
	#closed = false;
	#getStream: Promise<void> | undefined;
	#getStreamTimer: ReturnType<typeof setTimeout> | undefined;
	#getStreamAttempts = 0;

	constructor(options: StreamableHttpTransportOptions) {
		super();
		this.#options = options;
		this.#fetch = options.fetch ?? fetch;
	}

	async start(): Promise<void> {
		if (this.#started) throw new Error("MCP HTTP transport already started");
		if (this.#closed) throw new McpConnectionClosedError();
		this.#started = true;
	}

	setProtocolVersion(version: string): void {
		this.#protocolVersion = version;
		this.#startGetStream();
	}

	async send(message: JsonRpcMessage, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
		if (!this.#started || this.#closed) throw new McpConnectionClosedError();
		const signal = options.signal
			? AbortSignal.any([options.signal, this.#closeController.signal])
			: this.#closeController.signal;
		let response: Response;
		try {
			response = await this.#fetch(this.#options.url, {
				method: "POST",
				headers: this.#headers("application/json, text/event-stream"),
				body: JSON.stringify(message),
				signal,
			});
		} catch (error) {
			throw signal.aborted ? new McpAbortError() : error;
		}
		this.#captureSession(response);
		if (!response.ok) {
			throw new McpHttpError(
				response.status,
				`MCP HTTP request failed with status ${response.status}`,
				await readSnippet(response),
			);
		}

		const type = contentType(response);
		if (type === "text/event-stream") {
			if (response.body === null) throw new McpConnectionClosedError("MCP HTTP response has no body");
			// 通知没有回音要等；响应流可能在服务端保持打开，不能在 send 里干等
			if (!("id" in message)) {
				void this.#consumeStream(response.body, signal).catch(() => undefined);
				return;
			}
			await this.#consumeStream(response.body, signal);
			return;
		}

		const text = await response.text();
		if (text.trim().length === 0) return; // 通知通常没有响应体
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new McpConnectionClosedError("MCP HTTP response was not valid JSON");
		}
		if (Array.isArray(parsed)) {
			for (const item of parsed) this.emitMessage(parseJsonRpcMessage(item));
			return;
		}
		this.emitMessage(parseJsonRpcMessage(parsed));
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#getStreamTimer !== undefined) {
			clearTimeout(this.#getStreamTimer);
			this.#getStreamTimer = undefined;
		}
		this.#closeController.abort();
		await this.#getStream?.catch(() => undefined);
		this.emitClose();
	}

	#headers(accept: string, withContentType = true): Record<string, string> {
		return {
			...(withContentType ? { "content-type": "application/json" } : {}),
			accept,
			...(this.#sessionId === undefined ? {} : { "mcp-session-id": this.#sessionId }),
			...(this.#protocolVersion === undefined ? {} : { "mcp-protocol-version": this.#protocolVersion }),
			...(this.#options.headers ?? {}),
		};
	}

	#captureSession(response: Response): void {
		const session = response.headers.get("mcp-session-id");
		if (session !== null && session.length > 0) this.#sessionId = session;
	}

	async #consumeStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		try {
			for await (const event of parseSse(stream, { signal })) {
				if (event.data.length === 0 || event.data === "[DONE]") continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(event.data);
				} catch {
					throw new McpConnectionClosedError("MCP SSE event was not valid JSON");
				}
				this.emitMessage(parseJsonRpcMessage(parsed));
			}
		} catch (error) {
			if (signal.aborted) throw new McpAbortError();
			throw error;
		}
	}

	#startGetStream(): void {
		if (this.#closed || this.#options.openGetStream === false) return;
		if (this.#getStream !== undefined || this.#getStreamTimer !== undefined) return;
		this.#getStream = this.#runGetStream()
			.catch(() => undefined)
			.finally(() => {
				this.#getStream = undefined;
			});
	}

	async #runGetStream(): Promise<void> {
		const signal = this.#closeController.signal;
		let response: Response;
		try {
			response = await this.#fetch(this.#options.url, {
				method: "GET",
				headers: this.#headers("text/event-stream", false),
				signal,
			});
		} catch {
			if (!this.#closed) this.#scheduleGetStreamRetry();
			return;
		}
		if (!response.ok) {
			// 服务端没有 server→client 通道时安静放弃；工具调用本身不受影响
			if (!GET_STREAM_UNSUPPORTED.has(response.status)) this.#scheduleGetStreamRetry();
			return;
		}
		if (response.body === null) return;
		this.#getStreamAttempts = 0;
		try {
			await this.#consumeStream(response.body, signal);
		} catch {
			// 流断开后按退避重连；close 会取消重连
		}
		if (!this.#closed) this.#scheduleGetStreamRetry();
	}

	#scheduleGetStreamRetry(): void {
		if (this.#closed || this.#getStreamTimer !== undefined) return;
		const delay = GET_STREAM_RETRY_DELAYS_MS[this.#getStreamAttempts];
		if (delay === undefined) return;
		this.#getStreamAttempts += 1;
		const timer = setTimeout(() => {
			this.#getStreamTimer = undefined;
			this.#startGetStream();
		}, delay);
		timer.unref?.();
		this.#getStreamTimer = timer;
	}
}

function contentType(response: Response): string | undefined {
	return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

async function readSnippet(response: Response): Promise<string> {
	try {
		const text = await response.text();
		return text.length > ERROR_BODY_CHARS ? `${text.slice(0, ERROR_BODY_CHARS)}…` : text;
	} catch {
		return "";
	}
}
