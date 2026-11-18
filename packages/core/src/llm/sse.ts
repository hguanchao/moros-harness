import type { ReadableStreamReadResult } from "node:stream/web";
import { ProviderError } from "./retry.ts";

export interface SseMessage {
	event?: string;
	data: string;
	id?: string;
}

export interface SseOptions {
	readonly idleTimeoutMs?: number;
	readonly signal?: AbortSignal;
}

/** 按 SSE 行协议分块解码，处理 CRLF、跨 chunk 行、多 data 行和 EOF 尾帧。 */
export async function* parseSse(
	stream: ReadableStream<Uint8Array>,
	options: SseOptions = {},
): AsyncGenerator<SseMessage> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "";
	let id: string | undefined;
	let data: string[] = [];
	let first = true;

	const dispatch = (): SseMessage | undefined => {
		if (data.length === 0) {
			event = "";
			return undefined;
		}
		const message: SseMessage = { data: data.join("\n") };
		if (event) message.event = event;
		if (id !== undefined) message.id = id;
		event = "";
		data = [];
		return message;
	};

	try {
		while (true) {
			const { value, done } = await readNextChunk(reader, options);
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			if (first) {
				first = false;
				if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
			}
			let newline: number;
			while ((newline = buffer.search(/[\r\n]/)) >= 0) {
				if (buffer[newline] === "\r" && newline === buffer.length - 1 && !done) break;
				const line = buffer.slice(0, newline);
				const width = buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
				buffer = buffer.slice(newline + width);
				if (line === "") {
					const message = dispatch();
					if (message) yield message;
					continue;
				}
				if (line.startsWith(":")) continue;
				const colon = line.indexOf(":");
				const field = colon < 0 ? line : line.slice(0, colon);
				const fieldValue = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
				if (field === "data") data.push(fieldValue);
				else if (field === "event") event = fieldValue;
				else if (field === "id" && !fieldValue.includes("\0")) id = fieldValue;
			}
			if (done) break;
		}
		if (buffer.length > 0) {
			const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
			if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
			else if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
		}
		const final = dispatch();
		if (final) yield final;
	} finally {
		reader.releaseLock();
	}
}

async function readNextChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	options: SseOptions,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (options.signal?.aborted) throw abortError();
	const read = reader.read();
	const idleTimeoutMs = options.idleTimeoutMs ?? 0;
	if (idleTimeoutMs <= 0 && !options.signal) return read;

	let timeout: ReturnType<typeof setTimeout> | undefined;
	let abortHandler: (() => void) | undefined;
	const guards: Array<Promise<never>> = [];
	if (idleTimeoutMs > 0) {
		guards.push(
			new Promise((_, reject) => {
				timeout = setTimeout(() => {
					reject(new ProviderError("Model stream idle timeout", undefined, undefined, true));
					void reader.cancel("stream idle timeout");
				}, idleTimeoutMs);
			}),
		);
	}
	if (options.signal) {
		guards.push(
			new Promise((_, reject) => {
				abortHandler = () => {
					void reader.cancel("request aborted");
					reject(abortError());
				};
				options.signal!.addEventListener("abort", abortHandler, { once: true });
			}),
		);
	}
	try {
		return await Promise.race([read, ...guards]);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (abortHandler && options.signal) options.signal.removeEventListener("abort", abortHandler);
	}
}

function abortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}
