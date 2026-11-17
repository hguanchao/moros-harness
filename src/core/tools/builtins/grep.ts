import { readFile, readdir, stat } from "node:fs/promises";
import { basename, relative, sep } from "node:path";

import micromatch from "micromatch";
import { z } from "zod";

import type { ToolDefinition, ToolResult } from "#src/core/harness/types.ts";
import { asToolArguments } from "#src/core/tools/tool-utils.ts";
import { isMissingPath } from "#src/core/fs-error.ts";

const GREP_SCHEMA = z.object({
	pattern: z.string().max(512).describe("Literal text or regular expression to search for."),
	path: z.string().default(".").describe("File or directory to search."),
	glob: z.string().optional().describe("Optional glob filter applied to file names."),
	ignoreCase: z.boolean().default(false).describe("Perform a case-insensitive search."),
	literal: z.boolean().default(false).describe("Treat the pattern as literal text."),
	limit: z.number().int().positive().max(1000).default(100).describe("Maximum number of matching lines."),
});
const IGNORED_DIRECTORIES = new Set([".git", ".moros", "node_modules", "dist"]);
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LINE_LENGTH = 4000;

/**
 * 建立项目内文本搜索工具。
 * @returns 只搜索普通文件且不跟随符号链接的工具定义。
 */
export function createGrepTool(): ToolDefinition {
	return {
		name: "grep",
		description:
			"Search a file or project directory for a literal string or regular expression. Returns path:line:text matches.",
		schema: GREP_SCHEMA,
		resource: "read",
		paths: (args) => [asToolArguments(args).path as string],
		applyResolvedPaths: (args, paths) => ({ ...asToolArguments(args), path: paths[0] }),
		execute: async (args) => searchFiles(asToolArguments(args)),
	};
}

async function searchFiles(args: Record<string, unknown>): Promise<ToolResult> {
	const root = args.path as string;
	const pattern = args.pattern as string;
	if (!args.literal && isUnsafeRegex(pattern)) {
		throw new Error("Regular expression has nested quantifiers and was rejected; simplify it or set literal=true");
	}
	const flags = args.ignoreCase ? "i" : "";
	const expression = args.literal ? undefined : new RegExp(pattern, flags);
	const expected = args.ignoreCase ? pattern.toLocaleLowerCase("en-US") : pattern;
	const matches: string[] = [];
	const pending = [root];
	const limit = args.limit as number;
	let truncated = false;
	let skippedBinary = 0;
	let skippedLarge = 0;
	let skippedUnreadable = 0;
	let skippedDirectories = 0;

	// 单文件目标（schema 明确写着「File or directory」）：原实现只 readdir 不处理文件，
	// readdir(file) 抛 ENOTDIR 又被当作缺失静默跳过 → 返回空结果，模型误判「grep 只收目录」
	// （真实使用反馈）。这里先判目标类型，文件直接搜。
	const targetStat = await stat(root).catch((error: unknown) => {
		if (isMissingPath(error)) throw new Error(`Path does not exist: ${root}`);
		throw error;
	});
	const singleFile = targetStat.isFile() ? root : undefined;

	while ((singleFile !== undefined ? matches.length === 0 : pending.length > 0) && matches.length < limit) {
		const directory = singleFile ?? pending.pop()!;
		let entries;
		if (singleFile !== undefined) {
			entries = [
				{ name: basename(singleFile), isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
			];
		} else {
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch {
				// 遍历期间目录被删或没有权限：跳过，不拖垮整次搜索
				skippedDirectories += 1;
				continue;
			}
		}
		for (const entry of entries) {
			if (IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
			const path = singleFile ?? `${directory}${sep}${entry.name}`;
			if (!singleFile && entry.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!entry.isFile() || (args.glob && !micromatch.isMatch(entry.name, args.glob as string, { dot: true })))
				continue;
			let data: Buffer;
			try {
				data = await readFile(path);
			} catch {
				// 单个文件读不了（权限、遍历期间被删）不该让整次搜索失败
				skippedUnreadable += 1;
				continue;
			}
			if (data.byteLength > MAX_FILE_BYTES) {
				skippedLarge += 1;
				continue;
			}
			// 二进制文件按 UTF-8 逐行读出来几乎全是乱码，匹配结果也不可信；直接跳过
			if (data.subarray(0, 8192).includes(0)) {
				skippedBinary += 1;
				continue;
			}
			const lines = data
				.toString("utf8")
				.replace(/^\uFEFF/, "")
				.split(/\r?\n/);
			for (const [index, fullLine] of lines.entries()) {
				const cut = fullLine.length > MAX_LINE_LENGTH;
				const line = cut ? `${fullLine.slice(0, MAX_LINE_LENGTH)}…` : fullLine;
				const matched = expression
					? expression.test(line)
					: args.ignoreCase
						? line.toLocaleLowerCase("en-US").includes(expected)
						: line.includes(expected);
				// 单文件目标的命中行只写文件名，避免 relative(文件, 文件) 得到空串
				const label = singleFile !== undefined ? entry.name : `${relative(root, path).split(sep).join("/")}`;
				if (matched) matches.push(`${label}:${index + 1}:${line}`);
				if (matches.length >= limit) {
					truncated = true;
					break;
				}
			}
			if (matchedLimit(matches, limit)) break;
		}
		if (singleFile !== undefined) break;
	}
	if (matches.length === 0) {
		const skipped = skipNote(skippedBinary, skippedLarge, skippedUnreadable, skippedDirectories);
		return { content: skipped.length === 0 ? "No matches." : `No matches. ${skipped}` };
	}
	const content = matches.join("\n");
	// 截断提示：limit 是显示上限，不是「只有这么多命中」
	const notes = [
		...(truncated ? [`[truncated at ${limit} matching lines]`] : []),
		...(skipNote(skippedBinary, skippedLarge, skippedUnreadable, skippedDirectories) === ""
			? []
			: [skipNote(skippedBinary, skippedLarge, skippedUnreadable, skippedDirectories)]),
	];
	return { content: notes.length === 0 ? content : `${content}\n${notes.join("\n")}` };
}

/** 被跳过的文件/目录说明；各类都为 0 时返回空串。 */
function skipNote(binary: number, large: number, unreadable: number, directories: number): string {
	const parts = [
		...(binary > 0 ? [`${binary} binary file(s)`] : []),
		...(large > 0 ? [`${large} oversized file(s)`] : []),
		...(unreadable > 0 ? [`${unreadable} unreadable file(s)`] : []),
		...(directories > 0 ? [`${directories} director${directories === 1 ? "y" : "ies"}`] : []),
	];
	return parts.length === 0 ? "" : `[${parts.join(", ")} skipped]`;
}

/** 命中数达到上限就停；独立成函数，避免两处 `>= limit` 判断漂移。 */
function matchedLimit(matches: readonly string[], limit: number): boolean {
	return matches.length >= limit;
}

function isUnsafeRegex(pattern: string): boolean {
	return /\([^)]*[+*][^)]*\)[+*{]/.test(pattern) || /(?:\.\*|\.\+){2,}/.test(pattern);
}
