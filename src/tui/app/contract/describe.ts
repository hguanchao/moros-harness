import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { commandCore } from "#src/tui/app/contract/command-summary.ts";

/** 只读探索工具的分组类型；其他工具不参与工具组。 */
export type ToolGroupKind = "read" | "list" | "search" | "command";

/** Moros Harness 内置工具里缩写不适合直接展示的名称。 */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
	glob: "Glob",
	grep: "Grep",
	bash: "Bash",
	powershell: "PowerShell",
};

/** 工具展示名的唯一入口；带命名空间的工具名保持原样。 */
export function displayToolName(tool: string): string {
	if (tool.length === 0 || tool.includes("__") || tool.includes(":")) return tool;
	const renamed = DISPLAY_NAMES[tool];
	if (renamed !== undefined) return renamed;
	const chars = Array.from(tool);
	return `${(chars[0] ?? "").toUpperCase()}${chars.slice(1).join("")}`;
}

/** 多行内容逐行清理：ANSI 与终端控制字符都不能带进界面。 */
export function sanitizeDetail(text: string): string {
	return text.split("\n").map(sanitizeLine).join("\n");
}

/** 摘要只占一行：换行与制表折成空格，转义序列不能带进终端。 */
export function sanitizeLine(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, "");
}

/** 工具调用在对话流里的呈现描述。 */
export interface ToolDescription {
	readonly name: string;
	readonly detail: string;
	readonly fullDetail?: string;
	readonly linkTarget?: string;
	readonly group?: ToolGroupKind;
}

/** Moros Harness 内置工具按资源类型分组；写类工具不参与只读分组。 */
function toolGroup(tool: string): ToolGroupKind | undefined {
	if (tool === "read") return "read";
	if (tool === "glob") return "list";
	if (tool === "grep") return "search";
	if (tool === "bash" || tool === "powershell") return "command";
	return undefined;
}

/** 是否属于命令执行工具。 */
export function isCommandTool(tool: string): boolean {
	return tool === "bash" || tool === "powershell";
}

/** 展开时直接展示结果正文的内置工具；它们的调用参数不再重复成 JSON。 */
const RESULT_IS_DETAIL = new Set(["read", "write", "edit", "glob", "grep"]);

/** 展开详情的上限：先清控制字符，再收敛行数，最后按字符数兜底。 */
const DETAIL_MAX_LINES = 40;
const DETAIL_MAX_CHARS = 8 * 1024;

/**
 * 生成工具调用的展示描述：detail 是折叠行的一行摘要，fullDetail 是展开后的完整内容。
 *
 * 命令只留核心段（工作根 `cd` 与管道后的处理方式留给展开）；文件工具只留 basename；
 * 搜索工具显示模式与范围。linkTarget 让参数在支持 OSC 8 的终端里成为可点击链接。
 */
export function describeToolCall(tool: string, args: Record<string, unknown>, workspaceRoot?: string): ToolDescription {
	const group = toolGroup(tool);
	const detail = sanitizeLine(describeDetail(tool, args, workspaceRoot));
	const fullDetail = describeFullDetail(tool, args, detail);
	const linkTarget = fileLinkTarget(tool, args, workspaceRoot);
	return {
		name: displayToolName(tool),
		detail,
		...(fullDetail === undefined ? {} : { fullDetail }),
		...(linkTarget === undefined ? {} : { linkTarget }),
		...(group === undefined ? {} : { group }),
	};
}

/** 折叠行的目标：文件工具用 basename，搜索工具用模式与范围，命令用核心命令。 */
function describeDetail(tool: string, args: Record<string, unknown>, workspaceRoot: string | undefined): string {
	if (isCommandTool(tool)) {
		return commandCore(sanitizeLine(text(args["command"]) ?? "(no command)"), workspaceRoot);
	}
	switch (tool) {
		case "read":
		case "write":
		case "edit":
			return basenamePath(text(args["path"]) ?? "(missing path)");
		case "glob": {
			const pattern = text(args["pattern"]) ?? "(no pattern)";
			return withModifiers(shortenText(pattern, 48), scopeModifiers(args["path"]));
		}
		case "grep": {
			const pattern = text(args["pattern"]) ?? "(no pattern)";
			const modifiers = scopeModifiers(args["path"]);
			const glob = text(args["glob"]);
			if (glob !== undefined) modifiers.push(glob);
			return withModifiers(shortenText(pattern, 48), modifiers);
		}
		default: {
			const json = JSON.stringify(args);
			if (json === "{}") return "";
			const chars = Array.from(json);
			return chars.length > 160 ? `${chars.slice(0, 160).join("")}…` : json;
		}
	}
}

/** 展开后的完整参数；undefined 表示这次调用没有更多可展开的调用参数。 */
function describeFullDetail(tool: string, args: Record<string, unknown>, detail: string): string | undefined {
	// read/write/edit 的结果会被 attachToolResult 覆盖成文件内容，先放参数没有意义。
	// glob/grep 例外：它们的结果可能为空，或 tool_end 尚未到达，此时若连参数详情都没有，
	// 这一行不会被登记成可展开行，双击看起来就是坏的。先留参数 JSON 兜底，结果到了再覆盖。
	if (RESULT_IS_DETAIL.has(tool) && tool !== "glob" && tool !== "grep") return undefined;
	// 命令的展开就是完整命令：折叠态只留了核心段
	if (isCommandTool(tool)) {
		const full = sanitizeLine(text(args["command"]) ?? "(no command)");
		return full === detail ? undefined : full;
	}
	const json = JSON.stringify(args, null, 2);
	if (json === "{}") return undefined;
	return capDetail(json);
}

/**
 * 工具目标转成 OSC 8 可用的 file:// 链接。
 *
 * 折叠行的下划线由终端为链接绘制，所以每个工具都得有一个目标才有一致的线：
 * 文件工具指向文件，搜索工具指向搜索目录，命令指向执行时所在的工作根。
 */
function fileLinkTarget(
	tool: string,
	args: Record<string, unknown>,
	workspaceRoot: string | undefined,
): string | undefined {
	if (isCommandTool(tool)) return directoryUrl(".", workspaceRoot);
	if (tool === "read" || tool === "write" || tool === "edit") {
		const path = text(args["path"]);
		return path === undefined ? undefined : resolveUrl(path, workspaceRoot);
	}
	if (tool === "glob" || tool === "grep") {
		return directoryUrl(text(args["path"]) ?? ".", workspaceRoot);
	}
	return undefined;
}

function directoryUrl(path: string, workspaceRoot: string | undefined): string | undefined {
	const href = resolveUrl(path, workspaceRoot);
	// 目录 URL 以斜杠结尾，点击打开的是文件夹而不是它里面的同名文件
	return href === undefined || href.endsWith("/") ? href : `${href}/`;
}

function resolveUrl(path: string, workspaceRoot: string | undefined): string | undefined {
	const expanded = expandHome(path);
	// 没有工作根时无法可靠解析相对路径；绝对路径不受影响
	if (!isAbsolute(expanded) && workspaceRoot === undefined) return undefined;
	try {
		const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(workspaceRoot ?? ".", expanded);
		return pathToFileURL(absolute).href;
	} catch {
		// 无法编码成 URL 时宁可不挂链接，也不能让显示层拿到半截转义序列
		return undefined;
	}
}

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) return resolve(homedir(), input.slice(2));
	return input;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 路径只留最后一段；完整路径在展开里。 */
function basenamePath(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/);
	return parts.at(-1) ?? path;
}

/** 受宽度约束的短路径：保留尾部，前面用 `…/` 代替。 */
function shortenPath(path: string, limit: number): string {
	if (Array.from(path).length <= limit) return path;

	const parts = path
		.replaceAll("\\", "/")
		.split("/")
		.filter((part) => part.length > 0);
	if (parts.length <= 1) return shortenText(path, limit);

	let tail = parts.at(-1) ?? "";
	if (Array.from(tail).length + 2 > limit) return `…/${shortenText(tail, Math.max(1, limit - 2))}`;

	for (let index = parts.length - 2; index >= 0; index -= 1) {
		const candidate = `${parts[index]}/${tail}`;
		if (Array.from(candidate).length + 2 > limit) break;
		tail = candidate;
	}
	return `…/${tail}`;
}

/** 从开头截断，保留最有区分度的前缀。 */
function shortenText(value: string, limit: number): string {
	const chars = Array.from(value);
	if (chars.length <= limit) return value;
	return `${chars.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

/** 路径参数进入折叠行时附加的搜索范围。 */
function scopeModifiers(path: unknown): string[] {
	const value = text(path);
	return value === undefined || value === "." ? [] : [`in ${shortenPath(value, 36)}`];
}

function withModifiers(base: string, modifiers: readonly string[]): string {
	return modifiers.length === 0 ? base : `${base}  [${modifiers.join(", ")}]`;
}

/** 展开详情的总上限：先清掉终端控制字符，再收敛行数，最后按字符数兜底。 */
function capDetail(text: string): string {
	const lines = sanitizeDetail(text).split("\n");
	let result =
		lines.length > DETAIL_MAX_LINES
			? [...lines.slice(0, DETAIL_MAX_LINES - 1), `… (${lines.length - DETAIL_MAX_LINES + 1} more lines)`].join("\n")
			: lines.join("\n");

	const chars = Array.from(result);
	if (chars.length > DETAIL_MAX_CHARS) result = `${chars.slice(0, DETAIL_MAX_CHARS - 1).join("")}…`;
	return result;
}
