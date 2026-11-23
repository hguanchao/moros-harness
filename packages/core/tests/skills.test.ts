import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listSkills, userSkillDirectories } from "../src/skills.ts";

describe("用户级技能目录", () => {
	let homeDir: string;

	beforeEach(async () => {
		homeDir = await mkdtemp(join(tmpdir(), "moros-skills-"));
	});

	afterEach(async () => {
		await rm(homeDir, { recursive: true, force: true });
	});

	async function addSkill(directory: string, name: string, frontmatterName: string): Promise<string> {
		const skillDir = join(homeDir, directory, name);
		await mkdir(skillDir, { recursive: true });
		const path = join(skillDir, "SKILL.md");
		await writeFile(path, `---\nname: ${frontmatterName}\ndescription: ${name} 描述\n---\n`, "utf8");
		return path;
	}

	it("扫描 Moros、agents、codex、claude 四个用户级根目录", async () => {
		expect(userSkillDirectories(homeDir)).toEqual([
			join(homeDir, ".moros", "skills"),
			join(homeDir, ".agents", "skills"),
			join(homeDir, ".codex", "skills"),
			join(homeDir, ".claude", "skills"),
		]);

		await addSkill(".moros/skills", "moros-skill", "moros-skill");
		await addSkill(".agents/skills", "agents-skill", "agents-skill");
		await addSkill(".codex/skills", "codex-skill", "codex-skill");
		await addSkill(".claude/skills", "claude-skill", "claude-skill");

		const skills = await listSkills({ homeDir });
		expect(skills.map((skill) => skill.name)).toEqual(["agents-skill", "claude-skill", "codex-skill", "moros-skill"]);
		expect(skills.every((skill) => skill.scope === "user")).toBe(true);
	});

	it("忽略隐藏子目录、缺少 SKILL.md 的目录与不可读根目录", async () => {
		await addSkill(".agents/skills", ".hidden", "hidden");
		await mkdir(join(homeDir, ".codex", "skills", "no-manifest"), { recursive: true });
		await addSkill(".claude/skills", "valid", "valid");

		const skills = await listSkills({ homeDir });
		expect(skills.map((skill) => skill.name)).toEqual(["valid"]);
	});

	it("项目级技能仍只在信任后扫描", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "moros-skills-project-"));
		try {
			await addSkill(".moros/skills", "user-skill", "user-skill");
			const projectSkillDir = join(projectRoot, ".moros", "skills", "project-skill");
			await mkdir(projectSkillDir, { recursive: true });
			await writeFile(join(projectSkillDir, "SKILL.md"), "---\nname: project-skill\n---\n", "utf8");

			const untrusted = await listSkills({ homeDir, projectRoot, trusted: false });
			expect(untrusted.map((skill) => skill.name)).toEqual(["user-skill"]);

			const trusted = await listSkills({ homeDir, projectRoot, trusted: true });
			expect(trusted.map((skill) => skill.scope)).toEqual(["project", "user"]);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	it("同名技能保留所有来源并按路径区分", async () => {
		const morosPath = await addSkill(".moros/skills", "shared", "shared");
		const codexPath = await addSkill(".codex/skills", "shared", "shared");

		const skills = await listSkills({ homeDir });
		expect(skills).toHaveLength(2);
		expect(new Set(skills.map((skill) => skill.path))).toEqual(new Set([morosPath, codexPath]));
	});
});
