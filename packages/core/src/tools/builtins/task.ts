import { z } from "zod";

import type { ToolDefinition, ToolContext, ToolResult } from "../../harness/types.ts";
import { asToolArguments } from "../tool-utils.ts";

const TASK_SCHEMA = z.object({
	task: z
		.string()
		.min(1)
		.describe("Complete, self-contained instructions for the subagent; it cannot see this conversation."),
});

/**
 * 委派任务的执行通道；由 Core 注入，把 task 调用转成一次性子会话运行。
 *
 * Core 组装工具时才知道自己有哪些服务（会话管理、审批、配置），工具工厂保持纯定义，
 * 运行通道在装配时绑进来——与 bash 工具的 ShellAdapter 同一套路。
 */
export type TaskRunner = (task: string, context: ToolContext) => Promise<ToolResult>;

/**
 * 建立「委派子代理」工具。
 *
 * 委派本身不碰文件，按只读资源处理；子代理内部的动作照常走拦截管线与审批。执行通道
 * 由 Core 注入：工具定义不含任何会话或 LLM 依赖，保证工具面可以在无 Core 的测试里组装。
 * @param runner 子会话执行通道。
 * @returns task 工具定义。
 */
export function createTaskTool(runner: TaskRunner): ToolDefinition {
	return {
		name: "task",
		description:
			"Delegate a self-contained subtask to a one-shot subagent (read/write tools, no further delegation). " +
			"Use for isolated work such as exploring the codebase, gathering research, or batch editing. " +
			"The task text must be complete: the subagent cannot see this conversation. Only the subagent's final answer is returned.",
		schema: TASK_SCHEMA,
		resource: "read",
		execute: (args, context) => runner(extractTask(args), context),
	};
}

/** 参数已在管线经 zod 校验；这里再收窄一次，防御直接构造的调用。 */
function extractTask(args: unknown): string {
	const record = asToolArguments(args);
	const task = record["task"];
	return typeof task === "string" && task.length > 0 ? task : "";
}
