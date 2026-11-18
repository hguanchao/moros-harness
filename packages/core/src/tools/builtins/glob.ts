import { readdir, stat } from "node:fs/promises";
import { basename, relative, sep } from "node:path";

import micromatch from "micromatch";
import { z } from "zod";

import type { ToolDefinition, ToolResult } from "../../harness/types.ts";
import { asToolArguments } from "../tool-utils.ts";
import { isMissingPath } from "../../fs-error.ts";

const GLOB_SCHEMA = z.object({
	pattern: z.string().min(1).describe("Glob pattern relative to the search path."),
	path: z.string().default(".").describe("Directory to search from."),
});
const IGNORED_DIRECTORIES = new Set([".git", ".moros", "node_modules", "dist"]);
const MAX_MATCHES = 10_000;

/**
 * 建立递归 glob 文件查找工具。
 * @returns 只遍历项目目录、不跟随符号链接的工具定义。
 */
export function createGlobTool(): ToolDefinition {
	return {
		name: "glob",
		description:
			"List files matching a glob pattern, searched recursively from the given path. The path may be a directory or a single file.",
		schema: GLOB_SCHEMA,
		resource: "read",
		paths: (args) => [asToolArguments(args).path as string],
		applyResolvedPaths: (args, paths) => ({ ...asToolArguments(args), path: paths[0] }),
		execute: async (args) => findFiles(asToolArguments(args)),
	};
}

async function findFiles(args: Record<string, unknown>): Promise<ToolResult> {
	const root = args.path as string;
	const pattern = args.pattern as string;
	const info = await stat(root).catch((error: unknown) => {
		if (isMissingPath(error)) throw new Error(`Path does not exist: ${root}`);
		throw error;
	});
	// 单文件目标：pattern 与文件名匹配即可，不再 readdir（对文件 readdir 会 ENOTDIR）
	if (info.isFile()) {
		return { content: micromatch.isMatch(basename(root), pattern, { dot: true }) ? basename(root) : "No files match." };
	}

	const matches: string[] = [];
	const pending = [root];
	let skippedDirectories = 0;
	while (pending.length > 0 && matches.length < MAX_MATCHES) {
		const directory = pending.pop()!;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			// 遍历期间目录被删（构建产物目录常见）或没有权限：跳过，不拖垮整次查找
			skippedDirectories += 1;
			continue;
		}
		for (const entry of entries) {
			if (IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
			const path = `${directory}${sep}${entry.name}`;
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile()) {
				const relativePath = relative(root, path).split(sep).join("/");
				if (micromatch.isMatch(relativePath, pattern, { dot: true })) matches.push(relativePath);
			}
		}
	}
	if (matches.length === 0) {
		return {
			content:
				skippedDirectories === 0
					? "No files match."
					: `No files match. [${skippedDirectories} ${directories(skippedDirectories)} skipped]`,
		};
	}
	const content = matches.sort().join("\n");
	const notes = [
		...(matches.length >= MAX_MATCHES ? [`[truncated at ${MAX_MATCHES} matches]`] : []),
		...(skippedDirectories > 0 ? [`[${skippedDirectories} ${directories(skippedDirectories)} skipped]`] : []),
	];
	return { content: notes.length === 0 ? content : `${content}\n${notes.join("\n")}` };
}

function directories(count: number): string {
	return count === 1 ? "directory" : "directories";
}
