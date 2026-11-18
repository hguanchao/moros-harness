import { z } from "zod";

import type { ToolDefinition, ToolResult } from "../harness/types.ts";
import { isRecord } from "./json-rpc.ts";
import type { McpCallResult, McpToolInfo } from "./types.ts";

export interface McpToolOptions {
	readonly server: string;
	readonly info: McpToolInfo;
	readonly name: string;
	/** 执行一次远端调用；signal 中止时客户端会通知 server 取消。 */
	readonly call: (
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onProgress: (text: string) => void,
	) => Promise<McpCallResult>;
}

/**
 * 把远端工具映射成 Moros 的工具定义。
 *
 * 远端声明一律按最保守的一侧处理：`resource: "shell"` + `risk: high`。MCP server 可以自称
 * 只读，但那只影响它自己的行为，不能作为跳过审批的依据——否则一个说谎的 server 等于
 * 给自己开了后门。参数 schema 原样交给模型，细粒度校验由 server 负责。
 * @param options server 名、工具信息、对外名称与执行通道。
 * @returns 可直接注入 AgentLoop 的工具定义。
 */
export function createMcpTool(options: McpToolOptions): ToolDefinition {
	const description =
		options.info.description.length > 0
			? `[MCP ${options.server}] ${options.info.description}`
			: `[MCP ${options.server}] remote tool ${options.info.name}`;
	return {
		name: options.name,
		description,
		// 只保证参数是对象；真正的字段约束由远端按 inputSchema 校验
		schema: z.record(z.string(), z.unknown()),
		parameters: options.info.inputSchema,
		resource: "shell",
		risk: { level: "high", rule: "mcp-tool" },
		async execute(args, context): Promise<ToolResult> {
			const record = isRecord(args) ? args : {};
			const result = await options.call(options.info.name, record, context.signal, (text) => {
				void context.writeOutput?.(text);
			});
			return {
				content: result.content,
				...(result.isError ? { isError: true } : {}),
			};
		},
	};
}

/** 把 MCP 进度通知压成一行模型/界面都能读的文本；没有可用字段时返回 undefined。 */
export function formatMcpProgress(progress: unknown): string | undefined {
	if (!isRecord(progress)) return undefined;
	const message = typeof progress["message"] === "string" ? progress["message"].trim() : "";
	const value = typeof progress["progress"] === "number" ? progress["progress"] : undefined;
	const total = typeof progress["total"] === "number" ? progress["total"] : undefined;
	const counter = value === undefined ? "" : `${value}${total === undefined ? "" : `/${total}`}`;
	if (counter.length > 0 && message.length > 0) return `Progress ${counter}: ${message}`;
	if (counter.length > 0) return `Progress ${counter}`;
	return message.length > 0 ? message : undefined;
}
