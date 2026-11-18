import type { ToolDefinition } from "../harness/types.ts";
import { createBashTool, type BashToolOptions } from "./builtins/bash.ts";
import { createEditTool } from "./builtins/edit.ts";
import { createGlobTool } from "./builtins/glob.ts";
import { createGrepTool } from "./builtins/grep.ts";
import { createReadTool } from "./builtins/read.ts";
import { createTaskTool, type TaskRunner } from "./builtins/task.ts";
import { createTodoTool } from "./builtins/todo.ts";
import { createWriteTool } from "./builtins/write.ts";

export type { TaskRunner } from "./builtins/task.ts";

/** 内置工具组装选项；`taskRunner` 缺省时不装配 task 工具（单元测试等不启用委派的场景）。 */
export interface BuiltinToolOptions extends BashToolOptions {
	/** 子代理执行通道；提供时在工具面里加入 task 工具。 */
	readonly taskRunner?: TaskRunner;
}

/**
 * 按固定工具顺序组装内置工具，不包含管线策略或权限判断。
 * @param options Shell 适配配置与可选的子代理执行通道。
 * @returns read、glob、grep、edit、write、todo、平台 Shell 工具，注入 taskRunner 时外加 task。
 */
export function createBuiltinTools(options: BuiltinToolOptions = {}): readonly ToolDefinition[] {
	const tools: ToolDefinition[] = [
		createReadTool(),
		createGlobTool(),
		createGrepTool(),
		createEditTool(),
		createWriteTool(),
		createTodoTool(),
		createBashTool(options),
	];
	// task 工具只在执行通道就绪时装配：Core 运行态注入通道，未注入执行通道的调用点保持原工具面
	if (options.taskRunner !== undefined) tools.push(createTaskTool(options.taskRunner));
	return tools;
}
