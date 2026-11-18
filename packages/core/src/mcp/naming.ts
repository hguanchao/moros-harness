import { createHash } from "node:crypto";

/** 供应商对工具名的限制：最多 64 个 `[A-Za-z0-9_-]`。 */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * 生成 MCP 工具名：`mcp__<server>__<tool>`。
 *
 * 与 pi 的规则一致：除字母、数字、下划线外的字符一律转 `_`；超长或与已有工具重名时追加
 * 8 位内容 hash，保证同一个 server/tool 每次得到相同的名字。`isTaken` 用于跨 server 的
 * 冲突检测。
 * @param server server 名。
 * @param tool server 自己的工具名。
 * @param isTaken 该名字是否已被别的工具占用。
 */
export function createMcpToolName(
	server: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/** server 的工具命名空间：`mcp__<server>`，`-` 与工具名一样转成 `_`。 */
export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}
