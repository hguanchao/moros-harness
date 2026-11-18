import { parseJsonRpcMessage, type JsonRpcMessage } from "./json-rpc.ts";

/** 单帧安全上限；超过视为协议错误，不把内存交给对端。 */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** stderr 尾部保留量；`/mcps` 只展示诊断，不需要完整日志。 */
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

export interface JsonRpcLineReaderOptions {
	readonly maxMessageBytes?: number;
	readonly maxStderrBytes?: number;
	readonly onMessage: (message: JsonRpcMessage) => void;
	readonly onError: (error: Error) => void;
	readonly onStderr?: (chunk: string) => void;
}

/**
 * 把子进程 stdout 按 MCP stdio 的分帧规则切开：一行一条 JSON-RPC 报文。
 *
 * 一次 data 事件可能带半条报文、也可能带好几条；不完整的字节先缓存，等到换行再一次性
 * 拼接解析。stderr 按协议只放日志，保留尾部供失败诊断，不参与协议。
 */
export class JsonRpcLineReader {
	readonly #options: JsonRpcLineReaderOptions;
	#stdoutChunks: Buffer[] = [];
	#stdoutPendingBytes = 0;
	#stderrBuffer = Buffer.alloc(0);

	constructor(options: JsonRpcLineReaderOptions) {
		this.#options = options;
	}

	/** 最近收到的 stderr 尾部（UTF-8）。 */
	get stderr(): string {
		return this.#stderrBuffer.toString("utf8");
	}

	/** 接收一段 stdout 字节，按换行派发完整报文。 */
	readStdout(chunk: Uint8Array): void {
		const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		const maxMessageBytes = this.#options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		let start = 0;
		for (;;) {
			const newline = data.indexOf(0x0a, start);
			if (newline < 0) {
				if (start < data.length) {
					// 调用方可能复用 chunk 的内存，未完成部分必须复制
					this.#stdoutChunks.push(Buffer.from(data.subarray(start)));
					this.#stdoutPendingBytes += data.length - start;
				}
				if (this.#stdoutPendingBytes > maxMessageBytes) {
					this.#stdoutChunks = [];
					this.#stdoutPendingBytes = 0;
					this.#options.onError(new Error(`MCP stdio message exceeds ${maxMessageBytes} bytes`));
				}
				return;
			}
			let line = data.subarray(start, newline);
			if (this.#stdoutChunks.length > 0) {
				this.#stdoutChunks.push(line);
				line = Buffer.concat(this.#stdoutChunks, this.#stdoutPendingBytes + line.length);
				this.#stdoutChunks = [];
				this.#stdoutPendingBytes = 0;
			}
			start = newline + 1;
			if (line.length > maxMessageBytes) {
				this.#options.onError(new Error(`MCP stdio message exceeds ${maxMessageBytes} bytes`));
				continue;
			}
			const text = line.toString("utf8").replace(/\r$/, "");
			if (text.trim().length === 0) continue;
			try {
				this.#options.onMessage(parseJsonRpcMessage(JSON.parse(text)));
			} catch (error) {
				this.#options.onError(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	/** 接收一段 stderr 字节，只保留尾部。 */
	readStderr(chunk: Uint8Array): void {
		const maxStderrBytes = this.#options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		this.#stderrBuffer = Buffer.concat([this.#stderrBuffer, chunk]);
		if (this.#stderrBuffer.length > maxStderrBytes) {
			this.#stderrBuffer = this.#stderrBuffer.subarray(-maxStderrBytes);
		}
		const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
		this.#options.onStderr?.(text);
	}

	/** stdout 结束：没等到换行的半条报文属于协议错误，丢弃并报告。 */
	end(): void {
		if (Buffer.concat(this.#stdoutChunks).toString("utf8").trim().length > 0) {
			this.#options.onError(new Error("MCP stdio server closed with an incomplete JSON-RPC message"));
		}
		this.#stdoutChunks = [];
		this.#stdoutPendingBytes = 0;
	}
}
