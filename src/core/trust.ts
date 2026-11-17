import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { AppConfig } from "#src/core/config/schema.ts";
import { normalizeProjectRoot } from "#src/core/session/project-dir.ts";

/**
 * 工作区信任：项目配置与项目技能只有在明确信任后才生效。
 *
 * 信任决定持久化在全局 `config.toml` 的 `[trusts]` 表（路径键 → true/false）；一次性的
 * “仅本次运行信任”只存在进程内存。解析顺序：session-only 决定 → [trusts] 表（含祖先
 * 最近条目继承）→ 项目没有需要信任的资源时视为可信 → 否则未决定（端侧询问）。
 */

/** 项目里需要信任才会生效的资源。 */
export interface WorkspaceTrustResources {
	/** `<root>/.moros/project.toml` 的绝对路径；不存在时省略。 */
	readonly projectConfig?: string;
	/** `<root>/.moros/skills` 的绝对路径；不存在时省略。 */
	readonly skillsDirectory?: string;
	/** `<root>/AGENTS.md` 的绝对路径（工作区指令，ADR-16）；不存在时省略。 */
	readonly agentsFile?: string;
}

/** 列出项目的信任需求资源（只看存在性，不读内容）。 */
export function workspaceTrustResources(projectRoot: string): WorkspaceTrustResources {
	const configDir = join(resolve(projectRoot), ".moros");
	const projectConfig = join(configDir, "project.toml");
	const skillsDirectory = join(configDir, "skills");
	const agentsFile = join(resolve(projectRoot), "AGENTS.md");
	const hasConfig = existsSync(projectConfig);
	const hasSkills = existsSync(skillsDirectory);
	const hasAgents = existsSync(agentsFile);
	return {
		...(hasConfig ? { projectConfig } : {}),
		...(hasSkills ? { skillsDirectory } : {}),
		...(hasAgents ? { agentsFile } : {}),
	};
}

/** 是否需要信任才加载项目层：存在 project.toml、skills 目录或 AGENTS.md（工作区指令，ADR-16）。 */
export function requiresWorkspaceTrust(projectRoot: string): boolean {
	const resources = workspaceTrustResources(projectRoot);
	return (
		resources.projectConfig !== undefined ||
		resources.skillsDirectory !== undefined ||
		resources.agentsFile !== undefined
	);
}

/**
 * 从 `[trusts]` 表查路径决定，向上找最近的祖先条目（子目录继承父目录的信任结论）。
 * 表键先归一化（win32 小写）再比较，手写的非规范键也能命中。
 */
export function storedTrustDecision(config: AppConfig, projectRoot: string): boolean | undefined {
	const table = config.trusts;
	if (table === undefined) return undefined;
	const decisions = new Map<string, boolean>();
	for (const [key, value] of Object.entries(table)) {
		decisions.set(normalizeProjectRoot(key), value);
	}
	let current = normalizeProjectRoot(projectRoot);
	for (;;) {
		const decision = decisions.get(current);
		if (decision !== undefined) return decision;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * 解析工作区信任结论。
 * @param config 合并后的配置（含 `[trusts]` 表）。
 * @param projectRoot 项目根目录。
 * @param sessionTrusted 本进程内的一次性信任路径集合（已归一化）。
 * @returns true 已信任；false 已拒绝；null 尚未决定（端侧应询问）。
 */
export function resolveWorkspaceTrust(
	config: AppConfig,
	projectRoot: string,
	sessionTrusted?: ReadonlySet<string>,
): boolean | null {
	if (sessionTrusted?.has(normalizeProjectRoot(projectRoot))) return true;
	const stored = storedTrustDecision(config, projectRoot);
	if (stored !== undefined) return stored;
	if (!requiresWorkspaceTrust(projectRoot)) return true;
	return null;
}

/** 信任页要展示的 SKILL.md 清单：项目 skills 目录下含 SKILL.md 的技能（不递归进技能内部）。 */
export function trustPromptSkillFiles(skillsDirectory: string): readonly string[] {
	let entries: string[];
	try {
		entries = readdirSync(skillsDirectory);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const skillFile = join(skillsDirectory, entry, "SKILL.md");
		if (existsSync(skillFile)) files.push(skillFile);
	}
	return files.sort();
}
