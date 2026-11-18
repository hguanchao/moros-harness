/**
 * 将不可信工具参数收窄为对象。
 * @param value 待检查的参数值。
 * @returns 普通对象；输入不是对象时返回空对象。
 */
export function asToolArguments(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
