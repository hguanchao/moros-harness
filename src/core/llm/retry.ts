import type { LlmClientOptions, RetryOptions } from "#src/core/llm/types.ts";

/** HTTP 响应错误及请求重试分类信息。 */
export class ProviderError extends Error {
	// 显式字段而非构造函数参数属性：Node 的类型擦除（type stripping）不支持参数属性语法。
	readonly status: number | undefined;
	readonly headers: Headers | undefined;
	readonly retryable: boolean | undefined;

	constructor(message: string, status?: number, headers?: Headers, retryable?: boolean) {
		super(message);
		this.name = "ProviderError";
		this.status = status;
		this.headers = headers;
		this.retryable = retryable;
	}
}

/** 根据 HTTP 状态与错误类型判断请求是否可重试。 */
export function isRetryable(error: unknown): boolean {
	if (error instanceof ProviderError) {
		if (error.retryable !== undefined) return error.retryable;
		return error.status === undefined || [408, 409, 429].includes(error.status) || error.status >= 500;
	}
	return error instanceof TypeError;
}

/** 按可重试策略执行操作，退避等待可被 AbortSignal 中止。 */
export async function withRetry<T>(
	operation: () => Promise<T>,
	retry: RetryOptions,
	runtime: Pick<LlmClientOptions, "now" | "random" | "sleep"> = {},
): Promise<T> {
	const now = runtime.now ?? Date.now;
	const random = runtime.random ?? Math.random;
	const sleep = runtime.sleep ?? abortableSleep;
	for (let attempt = 0; ; attempt += 1) {
		if (retry.signal?.aborted) throw abortError();
		try {
			return await operation();
		} catch (error) {
			if (retry.signal?.aborted) throw abortError();
			if (attempt >= retry.maxRetries || !isRetryable(error)) throw error;
			const providerError = error instanceof ProviderError ? error : undefined;
			const delay = getDelay(providerError, attempt, retry.maxDelayMs, now(), random);
			retry.onRetry?.(error, attempt + 1, delay);
			await sleep(delay, retry.signal);
		}
	}
}

function getDelay(
	error: ProviderError | undefined,
	attempt: number,
	maxDelayMs: number,
	now: number,
	random: () => number,
): number {
	const retryAfterMs = error?.headers?.get("retry-after-ms");
	if (retryAfterMs && Number.isFinite(Number(retryAfterMs)))
		return Math.min(maxDelayMs, Math.max(0, Number(retryAfterMs)));
	const retryAfter = error?.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
		if (Number.isFinite(value)) return Math.min(maxDelayMs, Math.max(0, value));
	}
	const base = Math.min(500 * 2 ** attempt, maxDelayMs);
	return Math.max(0, Math.round(base * (0.75 + random() * 0.5)));
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError());
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function abortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}
