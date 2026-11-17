import { ProviderError } from "#src/core/llm/retry.ts";

/** 将不可信 JSON 值收窄为普通对象，拒绝数组与 null。 */
export function parseJsonObject(raw: string, message: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new ProviderError(message, undefined, undefined, false);
	}
	return asObject(value, message);
}

/** 将不可信值收窄为普通对象。 */
export function asObject(value: unknown, message = "Expected object"): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ProviderError(message, undefined, undefined, false);
	}
	return value as Record<string, unknown>;
}

/** 安全读取可能缺失的对象属性。 */
export function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const child: unknown = (value as Record<string, unknown>)[key];
	return child && typeof child === "object" && !Array.isArray(child) ? (child as Record<string, unknown>) : undefined;
}

/** 安全读取字符串属性。 */
export function stringAt(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const child: unknown = (value as Record<string, unknown>)[key];
	return typeof child === "string" ? child : undefined;
}
