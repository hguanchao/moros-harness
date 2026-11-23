import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSkillTool } from "../src/tools/builtins/skill.ts";
import type { SkillSummary } from "../src/skills.ts";
import type { ToolContext } from "../src/harness/types.ts";

describe("内置 skill 工具", () => {
	let homeDir: string;

	beforeEach(async () => {
		homeDir = await mkdtemp(join(tmpdir(), "moros-skill-tool-"));
	});

	afterEach(async () => {
		await rm(homeDir, { recursive: true, force: true });
	});

	async function addSkill(root: string, name: string, scope: "user" | "project", body: string): Promise<SkillSummary> {
		const dir = join(homeDir, root, name);
		await mkdir(dir, { recursive: true });
		const path = join(dir, "SKILL.md");
		await writeFile(path, `---\nname: ${name}\ndescription: ${name} 描述\n---\n${body}`, "utf8");
		return { name, description: `${name} 描述`, scope, path };
	}

	const context = (): ToolContext => ({
		sessionId: "s1",
		projectRoot: homeDir,
		policy: {} as ToolContext["policy"],
	});

	it("按名称加载正文，带 skill_content 包裹与 base directory 提示，且不含 frontmatter", async () => {
		const skill = await addSkill(".moros/skills", "greet", "user", "\n请用一句话问候。\n");
		const tool = createSkillTool([skill]);
		expect(tool.name).toBe("skill");
		expect(tool.resource).toBe("read");
		// 不声明 paths：技能目录在项目外，不能走 read 的沙箱解析。
		expect(tool.paths).toBeUndefined();

		const result = await tool.execute({ name: "greet" }, context());
		expect(result.isError).toBeUndefined();
		expect(result.content).toContain('<skill_content name="greet">');
		expect(result.content).toContain("请用一句话问候。");
		expect(result.content).toContain(
			`Base directory for this skill: ${join(homeDir, ".moros", "skills", "greet").replace(/\\/g, "/")}`,
		);
		expect(result.content).not.toContain("name: greet");
	});

	it("未知名称报错并列出可用技能", async () => {
		const skill = await addSkill(".moros/skills", "greet", "user", "\n正文\n");
		const result = await createSkillTool([skill]).execute({ name: "missing" }, context());
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Unknown skill: missing");
		expect(result.content).toContain("greet");
	});

	it("同名技能项目级优先", async () => {
		const user = await addSkill(".moros/skills", "shared", "user", "\n用户级正文\n");
		const project = await addSkill("project/.moros/skills", "shared", "project", "\n项目级正文\n");
		const result = await createSkillTool([user, project]).execute({ name: "shared" }, context());
		expect(result.content).toContain("项目级正文");
		expect(result.content).not.toContain("用户级正文");
	});
});
