import type { JsonRpcMessage } from "./json-rpc.ts";

/**
 * MCP 传输接缝。
 *
 * 传输层只负责「报文从哪来、往哪去」：stdio 是进程管道，Streamable HTTP 是请求/响应。
 * 请求与回音的配对、超时、取消都归 McpClient，传输层不认方法名。
 */

export interface McpTransport {
	/** 建立连接；起不来时抛错。 */
	start(): Promise<void>;
	/** initialize 协商完成后告知实际协议版本；HTTP 传输用它补后续请求头。 */
	setProtocolVersion?(version: string): void;
	/** 发一条报文；连接已关闭时抛错。 */
	send(message: JsonRpcMessage, options?: { readonly signal?: AbortSignal }): Promise<void>;
	/** 订阅收到的报文；返回取消订阅函数。 */
	onMessage(listener: (message: JsonRpcMessage) => void): () => void;
	/** 订阅连接关闭；只会触发一次。 */
	onClose(listener: () => void): () => void;
	/** 订阅传输层错误（非致命解析失败、管道错误等）。 */
	onError(listener: (error: Error) => void): () => void;
	/** 关闭连接并释放子进程/网络资源；可重复调用。 */
	close(): Promise<void>;
}

/** 各传输共用的监听器登记与事件派发。 */
export class TransportEvents {
	readonly #messages = new Set<(message: JsonRpcMessage) => void>();
	readonly #closes = new Set<() => void>();
	readonly #errors = new Set<(error: Error) => void>();
	#closed = false;

	onMessage(listener: (message: JsonRpcMessage) => void): () => void {
		this.#messages.add(listener);
		return () => this.#messages.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.#closes.add(listener);
		return () => this.#closes.delete(listener);
	}

	onError(listener: (error: Error) => void): () => void {
		this.#errors.add(listener);
		return () => this.#errors.delete(listener);
	}

	protected emitMessage(message: JsonRpcMessage): void {
		for (const listener of [...this.#messages]) listener(message);
	}

	protected emitError(error: Error): void {
		for (const listener of [...this.#errors]) listener(error);
	}

	/** 关闭事件只派发一次；重复调用是安全的。 */
	protected emitClose(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const listener of [...this.#closes]) listener();
	}

	protected get closed(): boolean {
		return this.#closed;
	}
}
