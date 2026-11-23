import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createUserSkill,
	deleteUserSkill,
	importSkillFromFolder,
	listSkills,
	readSkillBody,
	readSkillDocument,
	updateUserSkill,
	userSkillDirectories,
	type SkillSummary,
} from "../src/skills.ts";

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

describe("readSkillBody 按名称加载正文", () => {
	let homeDir: string;

	beforeEach(async () => {
		homeDir = await mkdtemp(join(tmpdir(), "moros-skill-body-"));
	});

	afterEach(async () => {
		await rm(homeDir, { recursive: true, force: true });
	});

	function summary(path: string): SkillSummary {
		return { name: "demo", description: "", scope: "user", path };
	}

	it("剥离 frontmatter 与 BOM，只返回正文", async () => {
		const path = join(homeDir, "SKILL.md");
		await writeFile(path, "\uFEFF---\nname: demo\ndescription: 说明\n---\n\n第一行\n第二行\n", "utf8");
		expect(await readSkillBody(summary(path))).toBe("\n第一行\n第二行\n");
	});

	it("没有 frontmatter 时原样返回正文", async () => {
		const path = join(homeDir, "plain.md");
		await writeFile(path, "直接是正文\n", "utf8");
		expect(await readSkillBody(summary(path))).toBe("直接是正文\n");
	});

	it("frontmatter 未闭合时整段按正文返回，与解析语义一致", async () => {
		const path = join(homeDir, "unclosed.md");
		await writeFile(path, "---\nname: demo\n没有闭合\n", "utf8");
		expect(await readSkillBody(summary(path))).toBe("---\nname: demo\n没有闭合\n");
	});

	it("正文超过 64KB 时抛错", async () => {
		const path = join(homeDir, "huge.md");
		await writeFile(path, "x".repeat(64 * 1024 + 1), "utf8");
		await expect(readSkillBody(summary(path))).rejects.toThrow("超过 64 KB");
	});
});

describe("用户技能写管理", () => {
	let homeDir: string;

	beforeEach(async () => {
		homeDir = await mkdtemp(join(tmpdir(), "moros-skill-write-"));
	});

	afterEach(async () => {
		await rm(homeDir, { recursive: true, force: true });
	});

	it("create → readSkillDocument → listSkills → update → delete 往返", async () => {
		const created = await createUserSkill(homeDir, "greet", { description: "问候用户", body: "\n请说你好。\n" });
		expect(created.name).toBe("greet");
		expect(created.scope).toBe("user");

		const doc = await readSkillDocument(created.path);
		expect(doc).toEqual({ name: "greet", description: "问候用户", body: "\n请说你好。\n" });
		expect((await listSkills({ homeDir })).map((skill) => skill.name)).toContain("greet");

		const updated = await updateUserSkill(homeDir, created.path, { description: "新描述", body: "\n新正文\n" });
		expect(updated.description).toBe("新描述");
		expect((await readSkillDocument(created.path)).body).toBe("\n新正文\n");

		await deleteUserSkill(homeDir, created.path);
		expect((await listSkills({ homeDir })).map((skill) => skill.name)).not.toContain("greet");
	});

	it("拒绝非法名称与重复创建", async () => {
		await expect(createUserSkill(homeDir, "Bad_Name", { description: "", body: "" })).rejects.toThrow("kebab-case");
		await expect(createUserSkill(homeDir, "-bad", { description: "", body: "" })).rejects.toThrow("kebab-case");
		await createUserSkill(homeDir, "valid-name", { description: "", body: "" });
		await expect(createUserSkill(homeDir, "valid-name", { description: "", body: "" })).rejects.toThrow("已存在");
	});

	it("描述里的特殊字符序列化后能正确读回", async () => {
		const created = await createUserSkill(homeDir, "quotes", {
			description: '含 "引号" 与\n换行',
			body: "\n正文\n",
		});
		expect((await readSkillDocument(created.path)).description).toBe('含 "引号" 与\n换行');
	});

	it("拒绝操作用户技能目录之外的路径", async () => {
		const outside = join(homeDir, "outside-skill", "SKILL.md");
		await mkdir(join(homeDir, "outside-skill"));
		await writeFile(outside, "---\nname: outside\n---\nbody", "utf8");
		await expect(updateUserSkill(homeDir, outside, { description: "x", body: "y" })).rejects.toThrow("用户技能目录");
		await expect(deleteUserSkill(homeDir, outside)).rejects.toThrow("用户技能目录");
	});

	it("从文件夹导入技能，含附属文件；缺 SKILL.md 或非法名被拒", async () => {
		const source = join(homeDir, "source");
		await mkdir(join(source, "extra"), { recursive: true });
		await writeFile(
			join(source, "SKILL.md"),
			"---\nname: imported\ndescription: 导入的技能\n---\n\n导入正文\n",
			"utf8",
		);
		await writeFile(join(source, "extra", "data.txt"), "data", "utf8");

		const imported = await importSkillFromFolder(homeDir, source);
		expect(imported.name).toBe("imported");
		expect((await readSkillDocument(imported.path)).description).toBe("导入的技能");
		expect(await readFile(join(homeDir, ".moros", "skills", "imported", "extra", "data.txt"), "utf8")).toBe("data");

		const badSource = join(homeDir, "bad-source");
		await mkdir(badSource);
		await expect(importSkillFromFolder(homeDir, badSource)).rejects.toThrow("SKILL.md");
		await writeFile(join(badSource, "SKILL.md"), "---\nname: Bad_Name\n---\nbody", "utf8");
		await expect(importSkillFromFolder(homeDir, badSource)).rejects.toThrow("kebab-case");
	});
});
