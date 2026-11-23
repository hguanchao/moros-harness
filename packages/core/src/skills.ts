import { cp, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { atomicWriteFile } from "./atomic-file.ts";
import { isMissingPath } from "./fs-error.ts";

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
	/** SKILL.md 的绝对路径；skill 工具据此加载正文（不注入提示词，模型无需按路径读取） */
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

/** SKILL.md 正文上限：与技能清单扫描的解耦读取，防止单个技能撑爆工具结果。 */
const MAX_SKILL_BODY_BYTES = 64 * 1024;

/** SKILL.md 解析结果：frontmatter 元数据 + 正文。 */
export interface SkillDocument {
	readonly name: string;
	readonly description: string;
	readonly body: string;
}

/** 技能草稿：写回 SKILL.md 的用户可编辑字段（name 单独传，编辑时不可改）。 */
export interface SkillDraft {
	readonly description: string;
	readonly body: string;
}

/**
 * 解析 SKILL.md 开头的 YAML frontmatter（只支持标量 `key: value` 行）。
 * 没有闭合围栏时返回空表——此时整段内容视作正文，读取与扫描语义一致。
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
		if (value.startsWith('"') && value.endsWith('"')) {
			// 双引号值按 JSON 字符串解析，与 serializeSkillDocument 的 JSON.stringify 对称：
			// 能还原 \" \\ \n 等转义，描述里才能安全包含引号与换行。
			try {
				value = String(JSON.parse(value));
			} catch {
				value = value.slice(1, -1);
			}
		} else if (value.startsWith("'") && value.endsWith("'")) {
			value = value.slice(1, -1);
		}
		result[match[1]] = value;
	}
	return {};
}

/** 把 SKILL.md 原文拆成正文：只在 frontmatter 成对出现时去掉围栏。 */
function bodyOf(content: string): string {
	const lines = content.split(/\r?\n/);
	if ((lines[0] ?? "").trim() !== "---") return content;
	const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (close < 0) return content;
	return lines.slice(close + 1).join("\n");
}

/** 读原文并解析成 name/description/body；BOM 去掉，超过 64KB 抛错。 */
async function parseSkillFile(path: string, fallbackName?: string): Promise<SkillDocument> {
	const raw = await readFile(path, "utf8");
	if (Buffer.byteLength(raw, "utf8") > MAX_SKILL_BODY_BYTES) {
		throw new Error(`SKILL.md 超过 ${MAX_SKILL_BODY_BYTES / 1024} KB: ${fallbackName ?? path}`);
	}
	const content = raw.replace(/^\uFEFF/, "");
	const meta = frontmatter(content);
	return {
		name: (meta["name"] ?? "").trim() || fallbackName || "",
		description: (meta["description"] ?? "").trim(),
		body: bodyOf(content),
	};
}

/**
 * 读取一个技能的 SKILL.md 正文（去掉开头的 YAML frontmatter）。
 * @throws SKILL.md 不存在或超过 {@link MAX_SKILL_BODY_BYTES} 时抛错。
 */
export async function readSkillBody(skill: SkillSummary): Promise<string> {
	return (await parseSkillFile(skill.path, skill.name)).body;
}

/** 读取技能完整文档（名称/描述/正文），供编辑表单回填。 */
export async function readSkillDocument(skillPath: string): Promise<SkillDocument> {
	return parseSkillFile(skillPath);
}

/** 把草稿序列化成 SKILL.md 文本；description 用双引号包裹并转义，与 frontmatter 解析器兼容。 */
function serializeSkillDocument(name: string, draft: SkillDraft): string {
	const description = JSON.stringify(draft.description.trim());
	return `---\nname: ${name}\ndescription: ${description}\n---\n${draft.body}`;
}

/** 技能名：小写 kebab-case（与主流 agent 的技能目录约定一致）。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function validateSkillName(name: string): void {
	if (name.length === 0 || name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
		throw new Error("技能名只能使用小写字母、数字和连字符（kebab-case，最长 64 字符）");
	}
}

/**
 * 断言目标路径落在 `~/.moros/skills` 内（防越界与符号链接逃逸）。
 * 对尚不存在的目标走最近存在祖先的 realpath，再拼接剩余段判断包含关系。
 */
async function assertInsideUserSkills(homeDir: string, targetPath: string): Promise<void> {
	const root = resolve(userSkillsDirectory(homeDir));
	let rootReal: string;
	try {
		rootReal = await realpath(root);
	} catch (error) {
		if (!isMissingPath(error)) throw error;
		rootReal = root; // 目录不存在时按字面路径判断（create 会先建）
	}
	const target = resolve(targetPath);
	let cursor = target;
	const missing: string[] = [];
	let existing: string;
	for (;;) {
		try {
			existing = await realpath(cursor);
			break;
		} catch (error) {
			if (!isMissingPath(error)) throw error;
			const parent = dirname(cursor);
			if (parent === cursor) throw new Error("无法解析技能路径");
			missing.unshift(cursor.slice(parent.length).replace(/^[/\\]/, ""));
			cursor = parent;
		}
	}
	const reconstructed = missing.reduce((acc, segment) => join(acc, segment), existing);
	const rel = relative(rootReal, resolve(reconstructed));
	if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("/") || rel === "") {
		throw new Error("只能操作用户技能目录 ~/.moros/skills 内的技能");
	}
}

/** 技能目录下的 SKILL.md 路径。 */
function skillFilePath(homeDir: string, name: string): string {
	return join(userSkillsDirectory(homeDir), name, "SKILL.md");
}

/** 新建用户技能：name 必须 kebab-case 且目录不存在。 */
export async function createUserSkill(homeDir: string, name: string, draft: SkillDraft): Promise<SkillSummary> {
	validateSkillName(name);
	const path = skillFilePath(homeDir, name);
	await assertInsideUserSkills(homeDir, path);
	try {
		await stat(dirname(path));
		throw new Error(`技能 ${name} 已存在`);
	} catch (error) {
		if (!isMissingPath(error)) throw error;
	}
	await atomicWriteFile(path, serializeSkillDocument(name, draft));
	return { name, description: draft.description.trim(), scope: "user", path };
}

/** 更新用户技能：保留原 name，只替换描述与正文；路径必须落在用户技能目录内。 */
export async function updateUserSkill(homeDir: string, skillPath: string, draft: SkillDraft): Promise<SkillSummary> {
	await assertInsideUserSkills(homeDir, skillPath);
	const existing = await parseSkillFile(skillPath);
	const name = existing.name || skillPath.split(/[\\/]/).at(-2) || "";
	validateSkillName(name);
	await atomicWriteFile(skillPath, serializeSkillDocument(name, draft));
	return { name, description: draft.description.trim(), scope: "user", path: skillPath };
}

/** 删除用户技能（整个目录），路径必须落在用户技能目录内。 */
export async function deleteUserSkill(homeDir: string, skillPath: string): Promise<void> {
	await assertInsideUserSkills(homeDir, skillPath);
	const dir = dirname(skillPath);
	if (dir === resolve(userSkillsDirectory(homeDir))) throw new Error("拒绝删除技能根目录");
	await rm(dir, { recursive: true, force: true });
}

/**
 * 从本地目录导入技能：目录需含 SKILL.md，名字 kebab-case 且目标不存在。
 * 整个目录拷入 ~/.moros/skills/<name>，保留 SKILL.md 之外的附属文件。
 */
export async function importSkillFromFolder(homeDir: string, sourceDir: string): Promise<SkillSummary> {
	const source = resolve(sourceDir);
	const manifest = join(source, "SKILL.md");
	const doc = await parseSkillFile(manifest).catch(() => {
		throw new Error("所选目录不含可解析的 SKILL.md");
	});
	validateSkillName(doc.name);
	const targetDir = join(userSkillsDirectory(homeDir), doc.name);
	await assertInsideUserSkills(homeDir, join(targetDir, "SKILL.md"));
	try {
		await stat(targetDir);
		throw new Error(`技能 ${doc.name} 已存在`);
	} catch (error) {
		if (!isMissingPath(error)) throw error;
	}
	await mkdir(targetDir, { recursive: true });
	await cp(source, targetDir, { recursive: true });
	return { name: doc.name, description: doc.description, scope: "user", path: join(targetDir, "SKILL.md") };
}
