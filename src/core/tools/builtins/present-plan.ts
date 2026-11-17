import { z } from "zod";

import type { ToolDefinition, ToolResult } from "#src/core/harness/types.ts";
import { asToolArguments } from "#src/core/tools/tool-utils.ts";

const PRESENT_PLAN_SCHEMA = z.object({
	plan: z.string().min(1).describe("The complete implementation plan in Markdown."),
});

/**
 * 建立「提交计划」工具，只在计划模式下注入。
 *
 * 模型在只读规划阶段用它提交完整计划；界面把这次调用的参数渲染成计划卡，等待使用者
 * 批准后再进入实现。执行本身不改任何状态，因此按只读资源处理。
 * @returns 计划提交工具定义。
 */
export function createPresentPlanTool(): ToolDefinition {
	return {
		name: "present_plan",
		description:
			"Submit the complete plan for user approval. Use this in planning mode after exploring the workspace; describe steps, files, and risks.",
		schema: PRESENT_PLAN_SCHEMA,
		resource: "read",
		execute: async (args) => submitPlan(asToolArguments(args)),
	};
}

async function submitPlan(args: Record<string, unknown>): Promise<ToolResult> {
	const plan = args["plan"];
	const length = typeof plan === "string" ? plan.length : 0;
	return { content: `Plan submitted for approval (${length} characters).` };
}
