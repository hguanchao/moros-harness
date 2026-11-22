import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { stringify as stringifyToml } from "smol-toml";

import { isMissingPath } from "../fs-error.ts";

/** 允许由产品写回全局 config.toml 的顶层键；其余键仍由使用者手工维护。 */
export interface GlobalConfigPatch {
	/** providers.json 中的供应商名。 */
	readonly provider?: string;
	/** 该供应商下的模型 ID。 */
	readonly model?: string;
	/** 推理强度档位（off|minimal|low|medium|high|max）。 */
	readonly reasoningEffort?: string;
}

/** 各补写键可能出现的拼写；同一键两种拼写并存属配置错误，写回前必须先排除。 */
const KEY_SPELLINGS: Readonly<Record<keyof GlobalConfigPatch, readonly string[]>> = {
	provider: ["provider"],
	model: ["model"],
	reasoningEffort: ["reasoning_effort", "reasoningEffort"],
};

/** 新增行统一写成 snake_case。 */
const CANONICAL_KEYS: Readonly<Record<keyof GlobalConfigPatch, string>> = {
	provider: "provider",
	model: "model",
	reasoningEffort: "reasoning_effort",
};

/** 识别一行是否为指定键的「键 = 值」赋值行；注释行与表格头不匹配。 */
function matchAssignment(line: string, spellings: readonly string[]): string | undefined {
	const match = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
	const key = match?.[1];
	return key !== undefined && spellings.includes(key) ? key : undefined;
}

/** 逐行推进三引号多行字符串状态；处于字符串内部时不做任何键识别。 */
function nextMultilineState(inMultiline: boolean, line: string): boolean {
	let state = inMultiline;
	for (const delimiter of ['"""', "'''"] as const) {
		if ((line.split(delimiter).length - 1) % 2 === 1) state = !state;
	}
	return state;
}

/**
 * 把补丁写回全局 `~/.moros/config.toml`。
 *
 * 采用按行补写而不是整文件重序列化：文件是使用者手工维护的，模板里带有大量注释，
 * 整体重写会把注释与排版全部抹掉。已有键在原位整行替换为规范拼写（snake_case）；
 * 缺失的键插到第一个表格头之前（这些键只属于顶层作用域），没有表格头时追加到末尾。
 * 文件不存在时创建。写入采用临时名 → rename 原子替换，崩溃不会留下半截配置。
 *
 * @param patch 要写回的键值；只允许 GlobalConfigPatch 声明的顶层键。
 * @param options.homeDir 用户主目录，配置位于 `<homeDir>/.moros/config.toml`。
 * @throws 同一键的两种拼写并存（视为配置错误，与加载规则一致），或文件不可读时抛出。
 */
export async function updateGlobalConfig(patch: GlobalConfigPatch, options: { homeDir: string }): Promise<void> {
	const entries = Object.entries(patch) as Array<[keyof GlobalConfigPatch, string]>;
	if (entries.length === 0) return;
	const path = configPath(options.homeDir);
	const lines = await readConfigLines(path);
	/** 待原位替换：行索引 → 新行内容。 */
	const replacements = new Map<number, string>();
	/** 已在原位补写过的键；其余键转为插入行。 */
	const replacedKeys = new Set<keyof GlobalConfigPatch>();
	let inMultiline = false;
	let firstTableHeader = -1;

	for (const [index, line] of lines.entries()) {
		if (!inMultiline && /^\s*\[/.test(line) && firstTableHeader < 0) firstTableHeader = index;
		if (!inMultiline && (firstTableHeader < 0 || index < firstTableHeader)) {
			for (const [key, value] of entries) {
				const spelling = matchAssignment(line, KEY_SPELLINGS[key]);
				if (spelling === undefined) continue;
				if (replacedKeys.has(key)) {
					throw new Error(`Conflicting config keys in ${path}: ${key} appears more than once`);
				}
				replacedKeys.add(key);
				replacements.set(index, `${CANONICAL_KEYS[key]} = ${formatTomlValue(key, value)}`);
			}
		}
		inMultiline = nextMultilineState(inMultiline, line);
	}

	// 原位替换先落回行数组，再决定哪些键转为插入
	for (const [index, line] of replacements) lines[index] = line;

	const insertions = entries
		.filter(([key]) => !replacedKeys.has(key))
		.map(([key, value]) => `${CANONICAL_KEYS[key]} = ${formatTomlValue(key, value)}`);
	if (insertions.length > 0) {
		lines.splice(firstTableHeader < 0 ? lines.length : firstTableHeader, 0, ...insertions);
	}
	// 原文件没有结尾换行时补一个，保证追加行不会黏在前一行上
	await writeAtomically(path, lines);
}

/** `[trusts]` 表的补丁：按路径设置或删除信任决定。 */
export interface TrustsPatch {
	/** 归一化项目路径 → 决定 */
	readonly set?: Readonly<Record<string, boolean>>;
	/** 要删除的归一化项目路径 */
	readonly remove?: readonly string[];
}

/**
 * 把信任决定写回全局 config.toml 的 `[trusts]` 表。
 *
 * 路径键以双引号包裹并转义（TOML 基本字符串，与 JSON 转义一致）；已存在的条目原位
 * 替换，缺失条目追加到表尾；remove 命中的行删除。表不存在时在文件末尾新建。
 * 与 updateGlobalConfig 一样按行补写，保留其余注释与排版，临时名 → rename 原子写。
 * @param patch 决定集合；路径必须先由调用方归一化。
 * @param options.homeDir 用户主目录。
 * @throws 配置文件不可读时抛出错误。
 */
export async function updateGlobalTrusts(patch: TrustsPatch, options: { homeDir: string }): Promise<void> {
	const entries = Object.entries(patch.set ?? {});
	const removals = new Set(patch.remove ?? []);
	if (entries.length === 0 && removals.size === 0) return;
	const path = configPath(options.homeDir);
	const lines = await readConfigLines(path);

	// 定位 [trusts] 表；表内条目边界是下一个表头或文件末尾
	let sectionStart = -1;
	let sectionEnd = lines.length;
	for (const [index, line] of lines.entries()) {
		if (!/^\s*\[trusts\]\s*(?:#.*)?$/.test(line)) continue;
		sectionStart = index;
		for (let next = index + 1; next < lines.length; next += 1) {
			if (/^\s*\[/.test(lines[next] ?? "")) {
				sectionEnd = next;
				break;
			}
		}
		break;
	}

	/** 解析表内的一行「路径键 = 布尔」；不是条目行时返回 undefined。 */
	const parseEntry = (line: string): { key: string; quoted: string } | undefined => {
		const match = /^\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)\s*=\s*(?:true|false)\s*(?:#.*)?$/.exec(line);
		if (!match?.[1]) return undefined;
		const raw = match[1];
		if (!raw.startsWith('"')) return { key: raw, quoted: raw };
		try {
			return { key: String(JSON.parse(raw)), quoted: raw };
		} catch {
			return undefined;
		}
	};

	const remaining = new Map(entries.map(([key, value]) => [key, value]));
	if (sectionStart >= 0) {
		const kept: string[] = [];
		for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
			const line = lines[index] ?? "";
			const entry = parseEntry(line);
			if (entry === undefined) {
				kept.push(line);
				continue;
			}
			if (removals.has(entry.key)) continue;
			const next = remaining.get(entry.key);
			if (next === undefined) {
				kept.push(line);
				continue;
			}
			remaining.delete(entry.key);
			kept.push(`${entry.quoted} = ${next}`);
		}
		for (const [key, value] of remaining) kept.push(`${JSON.stringify(key)} = ${value}`);
		lines.splice(sectionStart + 1, sectionEnd - sectionStart - 1, ...kept);
	} else {
		const added = [...remaining].map(([key, value]) => `${JSON.stringify(key)} = ${value}`);
		if (added.length > 0) {
			if (lines.length > 0 && (lines.at(-1) ?? "").trim().length > 0) lines.push("");
			lines.push("[trusts]", ...added);
		}
	}

	await writeAtomically(path, lines);
}

/** 设置页可写的嵌套表：键为配置组，值按 canonical 名称与允许的拼写给出。 */
const SECTION_KEYS = {
	limits: {
		maxTurns: ["maxTurns", "max_turns"],
		spillThreshold: ["spillThreshold", "spill_threshold"],
		streamIdleTimeoutSec: ["streamIdleTimeoutSec", "stream_idle_timeout_sec"],
	},
	retry: {
		maxRetries: ["maxRetries", "max_retries"],
		maxDelayMs: ["maxDelayMs", "max_delay_ms"],
	},
	compaction: {
		compactAt: ["compactAt", "compact_at"],
		keepRecent: ["keepRecent", "keep_recent"],
		summaryTimeoutSec: ["summaryTimeoutSec", "summary_timeout_sec"],
	},
	ui: {
		theme: ["theme"],
		notify: ["notify"],
		fontSize: ["fontSize", "font_size"],
		fontFamily: ["fontFamily", "font_family"],
		workStepDetail: ["workStepDetail", "work_step_detail"],
		collapseTiming: ["collapseTiming", "collapse_timing"],
		collapsedReplies: ["collapsedReplies", "collapsed_replies"],
		codeWorkspace: ["codeWorkspace", "code_workspace"],
	},
} as const;

type SectionName = keyof typeof SECTION_KEYS;

/** 标量设置补丁；null 表示删除该键。 */
export interface ScalarSettingsPatch {
	readonly provider?: string | undefined;
	readonly model?: string | undefined;
	readonly reasoningEffort?: string | undefined;
	readonly approval?: string | undefined;
	readonly shellPath?: string | null | undefined;
	readonly httpProxy?: string | null | undefined;
}

const SCALAR_KEYS: Readonly<Record<keyof ScalarSettingsPatch, readonly string[]>> = {
	provider: ["provider"],
	model: ["model"],
	reasoningEffort: ["reasoning_effort", "reasoningEffort"],
	approval: ["approval"],
	shellPath: ["shell_path", "shellPath"],
	httpProxy: ["http_proxy", "httpProxy"],
};

const SCALAR_CANONICAL: Readonly<Record<keyof ScalarSettingsPatch, string>> = {
	provider: "provider",
	model: "model",
	reasoningEffort: "reasoning_effort",
	approval: "approval",
	shellPath: "shell_path",
	httpProxy: "http_proxy",
};

/** 可写入 TOML 的设置值；布尔用于 ui.codeWorkspace 等开关。 */
type SettingValue = string | number | boolean;

/** 嵌套表设置补丁；null 表示删除该键。 */
export type SectionSettingsPatch = {
	readonly [S in SectionName]?:
		| {
				readonly [K in keyof (typeof SECTION_KEYS)[S]]?: SettingValue | null | undefined;
		  }
		| undefined;
};

/**
 * 把设置页的改动写回全局 config.toml：顶层标量与四个嵌套表都按行补写。
 *
 * 与 updateGlobalConfig 相同，保留注释与排版；目标键在所属作用域内原位替换，缺失时
 * 顶层插到第一个表头前、嵌套项插到对应表尾，表不存在时新建。null 删除键。整体一次
 * 原子替换，不会出现半截配置。
 * @param patch 标量与嵌套表补丁。
 * @param options homeDir 用户主目录。
 * @throws 同一键两种拼写并存、配置不可读时抛出错误。
 */
export async function updateGlobalSettings(
	patch: ScalarSettingsPatch & SectionSettingsPatch,
	options: { homeDir: string },
): Promise<void> {
	const path = configPath(options.homeDir);
	const lines = await readConfigLines(path);
	let changed = false;

	const scalarEntries = Object.entries(SCALAR_KEYS) as Array<[keyof ScalarSettingsPatch, readonly string[]]>;
	for (const [key, spellings] of scalarEntries) {
		const value = patch[key];
		if (value === undefined) continue;
		changed = applyTopLevelValue(lines, spellings, SCALAR_CANONICAL[key], value) || changed;
	}

	for (const section of Object.keys(SECTION_KEYS) as SectionName[]) {
		const values = patch[section];
		if (!values) continue;
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) continue;
			const canonical = SCALAR_CANONICAL_FOR_SECTION(section, key);
			const spellings = SPELLINGS_FOR_SECTION(section, key);
			if (!canonical || !spellings) continue;
			changed = applySectionValue(lines, section, spellings, canonical, value) || changed;
		}
	}

	if (changed) await writeAtomically(path, lines);
}

/** 顶层键的作用域只到第一个表头；返回是否改动。 */
function applyTopLevelValue(
	lines: string[],
	spellings: readonly string[],
	canonical: string,
	value: string | null,
): boolean {
	let firstHeader = -1;
	for (const [index, line] of lines.entries()) {
		if (/^\s*\[/.test(line)) {
			firstHeader = index;
			break;
		}
	}
	const end = firstHeader < 0 ? lines.length : firstHeader;
	let replaced = false;
	for (let index = 0; index < end; index += 1) {
		const line = lines[index] ?? "";
		if (matchAssignment(line, spellings) === undefined) continue;
		if (replaced) throw new Error(`Conflicting config keys: ${canonical} appears more than once`);
		replaced = true;
		if (value === null) {
			lines.splice(index, 1);
			return true;
		}
		lines[index] = `${canonical} = ${formatValue(value)}`;
		return true;
	}
	if (value === null) return false;
	lines.splice(firstHeader < 0 ? lines.length : firstHeader, 0, `${canonical} = ${formatValue(value)}`);
	return true;
}

/** 在指定表内替换/删除/插入一个键；表不存在且需要插入时新建表。返回是否改动。 */
function applySectionValue(
	lines: string[],
	section: SectionName,
	spellings: readonly string[],
	canonical: string,
	value: SettingValue | null,
): boolean {
	let start = -1;
	let end = lines.length;
	for (const [index, line] of lines.entries()) {
		if (!new RegExp(`^\\s*\\[${section}\\]\\s*(?:#.*)?$`).test(line)) continue;
		start = index;
		for (let next = index + 1; next < lines.length; next += 1) {
			if (/^\s*\[/.test(lines[next] ?? "")) {
				end = next;
				break;
			}
		}
		break;
	}
	if (start >= 0) {
		let replaced = false;
		for (let index = start + 1; index < end; index += 1) {
			const line = lines[index] ?? "";
			if (matchAssignment(line, spellings) === undefined) continue;
			if (replaced) throw new Error(`Conflicting config keys: ${section}.${canonical} appears more than once`);
			replaced = true;
			if (value === null) {
				lines.splice(index, 1);
				return true;
			}
			lines[index] = `${canonical} = ${formatValue(value)}`;
			return true;
		}
		if (value === null) return false;
		lines.splice(end, 0, `${canonical} = ${formatValue(value)}`);
		return true;
	}
	if (value === null) return false;
	if (lines.length > 0 && (lines.at(-1) ?? "").trim().length > 0) lines.push("");
	lines.push(`[${section}]`, `${canonical} = ${formatValue(value)}`);
	return true;
}

function SPELLINGS_FOR_SECTION(section: SectionName, key: string): readonly string[] | undefined {
	const table = SECTION_KEYS[section] as Record<string, readonly string[]>;
	return table[key];
}

function SCALAR_CANONICAL_FOR_SECTION(section: SectionName, key: string): string | undefined {
	return SECTION_CANONICAL[section][key];
}

const SECTION_CANONICAL: Readonly<Record<SectionName, Readonly<Record<string, string>>>> = {
	limits: { maxTurns: "max_turns", spillThreshold: "spill_threshold", streamIdleTimeoutSec: "stream_idle_timeout_sec" },
	retry: { maxRetries: "max_retries", maxDelayMs: "max_delay_ms" },
	compaction: { compactAt: "compact_at", keepRecent: "keep_recent", summaryTimeoutSec: "summary_timeout_sec" },
	ui: {
		theme: "theme",
		notify: "notify",
		fontSize: "font_size",
		fontFamily: "font_family",
		workStepDetail: "work_step_detail",
		collapseTiming: "collapse_timing",
		collapsedReplies: "collapsed_replies",
		codeWorkspace: "code_workspace",
	},
};

/** 借助 smol-toml 序列化生成带正确转义的右侧值。 */
function formatValue(value: SettingValue): string {
	const serialized = stringifyToml({ value }).trimEnd();
	return serialized.slice(serialized.indexOf("=") + 1).trim();
}

/** 全局配置文件的固定位置。 */
function configPath(homeDir: string): string {
	return join(homeDir, ".moros", "config.toml");
}

/** 读取配置并按行切分；文件不存在时返回空行列表，其它读取错误照常抛出。 */
async function readConfigLines(path: string): Promise<string[]> {
	try {
		return (await readFile(path, "utf8")).split(/\r?\n/);
	} catch (error) {
		if (isMissingPath(error)) return [];
		throw new Error(`Cannot read configuration file ${path}`, { cause: error });
	}
}

/** 逐行补写的收尾：统一补齐结尾换行，再以临时名 → rename 原子替换。 */
async function writeAtomically(path: string, lines: string[]): Promise<void> {
	const output = `${lines.join("\n").replace(/\n*$/, "\n")}`;
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const temporary = join(directory, `config.${randomUUID()}.tmp`);
	await writeFile(temporary, output, "utf8");
	await rename(temporary, path);
}

/** 借助 smol-toml 的序列化生成带正确转义的赋值值；只取「键 = 值」的右侧部分。 */
function formatTomlValue(key: keyof GlobalConfigPatch, value: string): string {
	const serialized = stringifyToml({ [key]: value }).trimEnd();
	return serialized.slice(serialized.indexOf("=") + 1).trim();
}
