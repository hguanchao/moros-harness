import type { ProxyAgent } from "undici";

import { VERSION } from "../version.ts";
import { ProviderError } from "./retry.ts";
import type { ModelRequest } from "./types.ts";
import type { ProtocolAdapter } from "./protocol.ts";

/** 客户端标识 UA：如实亮明 Moros 身份与版本，供上游供应商识别（RFC 7231 单 token 形态）。 */
export const CLIENT_USER_AGENT = `moros/${VERSION}`;

export interface HttpTransportOptions {
	readonly fetch?: typeof fetch;
	/** HTTPS_PROXY 的可注入来源。 */
	readonly env?: NodeJS.ProcessEnv;
}

/** 通过原生 fetch 发起协议请求，并在完整消费响应流后释放请求时限。 */
export class HttpTransport {
	readonly #fetch: typeof fetch;
	readonly #env: NodeJS.ProcessEnv;

	constructor(options: HttpTransportOptions = {}) {
		this.#fetch = options.fetch ?? fetch;
		this.#env = options.env ?? process.env;
	}

	/** 在提供的回调中消费响应；超时覆盖请求头等待和响应流读取。 */
	async withResponse<T>(
		request: ModelRequest,
		adapter: ProtocolAdapter,
		signal: AbortSignal | undefined,
		consume: (stream: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error("Request timed out")), request.timeoutMs ?? 120_000);
		const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		let proxyAgent: ProxyAgent | undefined;

		try {
			const url = adapter.endpoint(request.baseUrl);
			const body = JSON.stringify(adapter.body(request));
			const headers = adapter.headers(request);
			// 客户端标识：未显式配置时补默认 UA，供应商 headers 里的同名头（大小写不敏感）优先
			const hasUserAgent = [...headers.keys()].some((key) => key.toLowerCase() === "user-agent");
			if (!hasUserAgent) headers.set("user-agent", CLIENT_USER_AGENT);
			const proxyUrl = request.httpProxy ?? (this.#fetch === fetch ? this.#env.HTTPS_PROXY : undefined);
			if (proxyUrl) {
				if (this.#fetch !== fetch) throw new Error("Custom fetch implementations cannot be combined with httpProxy");
				// 只有配了代理才需要 undici：静态导入会让每个用户都付它的加载成本（实测约 127 ms），
				// 而原生 fetch 不支持自定义 dispatcher，又绕不开它。
				const { ProxyAgent: createProxyAgent, fetch: undiciFetch } = await import("undici");
				proxyAgent = new createProxyAgent(proxyUrl);
				const proxyResponse = await undiciFetch(url, {
					method: "POST",
					headers: Object.fromEntries(headers.entries()),
					body,
					signal: combinedSignal,
					dispatcher: proxyAgent,
				});
				if (!proxyResponse.ok) {
					const raw = await proxyResponse.text();
					throw new ProviderError(
						errorMessage(raw),
						proxyResponse.status,
						new Headers(Object.fromEntries(proxyResponse.headers.entries())),
					);
				}
				if (!proxyResponse.body) throw new ProviderError("Provider response has no body", undefined, undefined, true);
				const proxyStream = proxyResponse.body as unknown as ReadableStream<Uint8Array>;
				return await consume(proxyStream, combinedSignal);
			}

			const response = await this.#fetch(url, {
				method: "POST",
				headers,
				body,
				signal: combinedSignal,
			});
			if (!response.ok) {
				const raw = await response.text();
				throw new ProviderError(errorMessage(raw), response.status, response.headers);
			}
			if (!response.body) throw new ProviderError("Provider response has no body", undefined, undefined, true);
			return await consume(response.body, combinedSignal);
		} catch (error) {
			if (controller.signal.aborted && !signal?.aborted) {
				throw new ProviderError("Provider request timed out", undefined, undefined, true);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			await proxyAgent?.close().catch(() => undefined);
		}
	}
}

function errorMessage(raw: string): string {
	try {
		const value: unknown = JSON.parse(raw);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const record = value as Record<string, unknown>;
			const nested = record.error;
			if (nested && typeof nested === "object" && !Array.isArray(nested)) {
				const message = (nested as Record<string, unknown>).message;
				if (typeof message === "string") return message.slice(0, 1000);
			}
			if (typeof record.message === "string") return record.message.slice(0, 1000);
		}
	} catch {
		return `Provider request failed (${raw.length} bytes)`;
	}
	return `Provider request failed (${raw.length} bytes)`;
}
