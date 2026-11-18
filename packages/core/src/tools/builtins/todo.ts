import { z } from "zod";

import type { ToolDefinition, ToolResult } from "../../harness/types.ts";
import { asToolArguments } from "../tool-utils.ts";

const TODO_SCHEMA = z.object({
	todos: z
		.array(
			z.object({
				content: z.string().min(1).describe("Task description shown to the user."),
				status: z.enum(["pending", "in_progress", "completed", "failed"]).describe("Current task state."),
				explanation: z.string().optional().describe("Optional short note for this task."),
			}),
		)
		.describe("The full task list; replacing it updates the user-visible task card."),
	explanation: z.string().optional().describe("Optional note shown with the task list."),
});

/**
 * 建立任务清单工具。
 *
 * 只影响界面上的任务卡：执行不碰文件、不跑命令，因此按只读资源处理，
 * 免审批也免沙箱。模型每次提交完整清单，界面以最新一次为准。
 * @returns 任务清单工具定义。
 */
export function createTodoTool(): ToolDefinition {
	return {
		name: "todo",
		description:
			"Maintain the task list for the current work. Send the complete list every time; empty or unchanged calls are allowed.",
		schema: TODO_SCHEMA,
		resource: "read",
		execute: async (args) => updateTodos(asToolArguments(args)),
	};
}

async function updateTodos(args: Record<string, unknown>): Promise<ToolResult> {
	const todos = args["todos"];
	const count = Array.isArray(todos) ? todos.length : 0;
	return { content: `Task list updated (${count} task${count === 1 ? "" : "s"}).` };
}
