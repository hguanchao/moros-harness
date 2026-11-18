import type { RpcResult } from "#src/desktop/shared/contract.ts";

/** 主进程返回的结构化错误；code 用于界面分支，message 直接展示。 */
export class DesktopApiError extends Error {
	readonly code: string | undefined;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "DesktopApiError";
		this.code = code;
	}
}

/**
 * 解包 RpcResult。
 * @throws DesktopApiError 主进程拒绝请求时抛出。
 */
export async function call<T>(promise: Promise<RpcResult<T>>): Promise<T> {
	const result = await promise;
	if (result.ok) return result.value;
	throw new DesktopApiError(result.error.message, result.error.code);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
