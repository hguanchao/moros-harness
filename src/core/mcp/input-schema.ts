/**
 * MCP 工具参数 schema 的归一化。
 *
 * 远端给的 `inputSchema` 原样交给模型，但有两处必须补齐：工具参数必须是对象；部分供应商
 * 会拒绝没有 `properties` 的对象 schema。多出来的关键字（anyOf、$ref 等）保持不动，
 * 真正的参数约束由 server 自己校验。
 */
export function normalizeMcpInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
	return {
		...schema,
		type: schema["type"] ?? "object",
		...(schema["properties"] === undefined ? { properties: {} } : {}),
	};
}
