import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * 技能（skills）：磁盘上的指令包，按固定目录约定扫描。
 *
 * 目录约定：用户级 `<home>/.{moros,agents,codex,claude}/skills/<name>/SKILL.md`，
 * 项目级 `<root>/.moros/skills/<name>/SKILL.md`。含 SKILL.md 的子目录即一个技能，
 * 不向技能目录内部继续递归。名字与描述取 SKILL.md 开头的 YAML frontmatter
 * （name/description），缺失时用目录名。
 */

/** 技能清单条目。 */
export interface SkillSummary {
	/** 技能名（frontmatter 的 name，缺省为目录名） */
	readonly name: string;
	/** 一句话描述，未声明时为空串 */
	readonly description: string;
	/** 用户级还是项目级 */
	readonly scope: "user" | "project";
	/** SKILL.md 的绝对路径；模型按此读取全文 */
	readonly path: string;
}

/** 用户级 Moros 技能目录。 */
export function userSkillsDirectory(homeDir: string): string {
	return join(homeDir, ".moros", "skills");
}

/** 用户级技能扫描目录：Moros 原生目录 + 主流 agent 的通用目录。 */
export function userSkillDirectories(homeDir: string): readonly string[] {
	return [".moros", ".agents", ".codex", ".claude"].map((name) => join(homeDir, name, "skills"));
}

/** 项目级技能目录。 */
export function projectSkillsDirectory(projectRoot: string): string {
	return join(resolve(projectRoot), ".moros", "skills");
}

/**
 * 扫描一个技能目录。
 * @param directory 技能根目录。
 * @param scope 结果标记的来源。
 * @returns 技能清单；目录不存在或不可读时返回空数组。
 */
export async function scanSkills(directory: string, scope: "user" | "project"): Promise<SkillSummary[]> {
	let entries: Array<{ name: string; isDirectory(): boolean }>;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const skills: SkillSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const path = join(directory, entry.name, "SKILL.md");
		let content: string;
		try {
			content = await readFile(path, "utf8");
		} catch {
			continue;
		}
		const meta = frontmatter(content);
		const name = (meta["name"] ?? "").trim() || entry.name;
		skills.push({
			name,
			description: (meta["description"] ?? "").trim(),
			scope,
			path,
		});
	}
	return skills.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 汇总用户级与（可选）项目级技能。
 * @param options.homeDir 用户主目录。
 * @param options.projectRoot 项目根目录。
 * @param options.trusted 项目未被信任时不扫描项目技能目录。
 */
export async function listSkills(options: {
	readonly homeDir: string;
	readonly projectRoot?: string;
	readonly trusted?: boolean;
}): Promise<SkillSummary[]> {
	const skills: SkillSummary[] = [];
	for (const directory of userSkillDirectories(options.homeDir)) {
		skills.push(...(await scanSkills(directory, "user")));
	}
	if (options.projectRoot !== undefined && options.trusted === true) {
		skills.push(...(await scanSkills(projectSkillsDirectory(options.projectRoot), "project")));
	}
	return skills.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 解析 SKILL.md 开头的 YAML frontmatter。
 *
 * 只支持标量 `key: value` 行；值两端的引号会被去掉。没有 frontmatter 时返回空表。
 * 解析失败的键值对直接跳过——技能清单是提示词增强，不因格式问题中断。
 */
function frontmatter(content: string): Record<string, string> {
	const lines = content.split(/\r?\n/);
	if ((lines[0] ?? "").trim() !== "---") return {};
	const result: Record<string, string> = {};
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim() === "---") return result;
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!match?.[1]) continue;
		let value = (match[2] ?? "").trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		result[match[1]] = value;
	}
	// 没有闭合的 frontmatter：整段内容不算元数据
	return {};
}
