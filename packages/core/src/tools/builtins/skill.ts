import { dirname } from "node:path";

import { z } from "zod";

import type { ToolDefinition, ToolResult } from "../../harness/types.ts";
import { readSkillBody, type SkillSummary } from "../../skills.ts";
import { asToolArguments } from "../tool-utils.ts";

const SKILL_SCHEMA = z.object({
	name: z.string().min(1).describe("The skill name, exactly as listed in the Skills section."),
});

/**
 * 建立「按名称加载技能正文」工具。
 *
 * 技能目录通常在项目根之外（~/.moros、~/.agents 等），走 read 工具会被路径沙箱拒绝；
 * 该工具不声明 paths()，由管线跳过沙箱解析，直接从已发现的技能清单里按名取正文。
 * 清单由 Core 在每轮构造工具时注入，保证工具与系统提示词里的技能一致。
 * @param skills 当前会话可用技能（用户级 + 项目级，已按信任过滤）。
 */
export function createSkillTool(skills: readonly SkillSummary[]): ToolDefinition {
	return {
		name: "skill",
		description:
			"Load the full instructions of a named skill before following it. Use only the names listed in the Skills section.",
		schema: SKILL_SCHEMA,
		resource: "read",
		execute: async (args) => loadSkill(asToolArguments(args), skills),
	};
}

async function loadSkill(args: Record<string, unknown>, skills: readonly SkillSummary[]): Promise<ToolResult> {
	const name = (args.name as string).trim();
	// 同名技能按项目级优先解析（与 DSH/ZCode 一致）；同级同名取清单里第一个。
	const skill =
		skills.find((entry) => entry.name === name && entry.scope === "project") ??
		skills.find((entry) => entry.name === name);
	if (skill === undefined) {
		const available = [...new Set(skills.map((entry) => entry.name))].sort().join(", ");
		return {
			content: `Unknown skill: ${name}. Available skills: ${available || "(none)"}`,
			isError: true,
		};
	}
	const body = await readSkillBody(skill);
	const baseDirectory = dirname(skill.path).replace(/\\/g, "/");
	return {
		content: `<skill_content name="${skill.name}">\n${body}\nBase directory for this skill: ${baseDirectory}\nRelative paths in this skill are relative to this base directory.\n</skill_content>`,
	};
}
