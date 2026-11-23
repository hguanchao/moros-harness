import { describe, expect, it } from "vitest";

import { buildSystemMessage, formatSkillsSection } from "../src/system-prompt.ts";
import type { SkillSummary } from "../src/skills.ts";

describe("技能清单提示词", () => {
	const skills: readonly SkillSummary[] = [
		{
			name: "greet",
			description: "问候用户",
			scope: "user",
			path: "C:/Users/someone/.moros/skills/greet/SKILL.md",
		},
	];

	it("清单只列名称、作用域与描述，不含 SKILL.md 绝对路径", () => {
		const section = formatSkillsSection(skills);
		expect(section).toContain("- greet (user): 问候用户");
		expect(section).not.toContain(skills[0]!.path);
		expect(section).not.toContain("SKILL.md");
		expect(section).toContain("skill tool");
	});

	it("空清单返回 undefined", () => {
		expect(formatSkillsSection([])).toBeUndefined();
	});

	it("buildSystemMessage 在工具面含 skill 时仍能追加清单节", () => {
		const message = buildSystemMessage({
			toolNames: ["read", "skill"],
			instructionsSection: undefined,
			skillsSection: formatSkillsSection(skills),
			workingDirectory: undefined,
			plan: false,
		});
		expect(message).toContain("## Skills");
		expect(message).toContain("- greet (user): 问候用户");
	});
});
