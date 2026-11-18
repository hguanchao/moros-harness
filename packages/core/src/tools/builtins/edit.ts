import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { z } from "zod";

import type { ToolDefinition, ToolResult } from "../../harness/types.ts";
import { asToolArguments } from "../tool-utils.ts";
import { atomicWriteFile } from "../../atomic-file.ts";
import { isDirectoryError, isMissingPath } from "../../fs-error.ts";

const EDIT_SCHEMA = z.object({
	path: z.string().min(1).describe("Project file path to edit."),
	edits: z
		.array(
			z.object({
				oldText: z.string().describe("Exact text that must occur once in the original file."),
				newText: z.string().describe("Replacement text."),
			}),
		)
		.min(1)
		.describe("Non-overlapping text replacements, each matched against the original file."),
});

/**
 * 建立精确文本替换工具。
 * @returns 通过 Harness 快照后执行文件替换的工具定义。
 */
export function createEditTool(): ToolDefinition {
	return {
		name: "edit",
		description: "Edit a project file using exact, unique text replacements.",
		schema: EDIT_SCHEMA,
		resource: "write",
		paths: (args) => [asToolArguments(args).path as string],
		applyResolvedPaths: (args, paths) => ({ ...asToolArguments(args), path: paths[0] }),
		execute: async (args) => applyEdits(asToolArguments(args)),
	};
}

async function applyEdits(args: Record<string, unknown>): Promise<ToolResult> {
	const path = args.path as string;
	const original = await readFile(path, "utf8").catch((error: unknown) => {
		// edit 的沙箱放行不存在的叶子（可能下一秒才创建），这里补一句可读诊断
		if (isMissingPath(error)) throw new Error(`File does not exist: ${path}`);
		if (isDirectoryError(error)) throw new Error("Path is a directory; edit targets a file");
		throw error;
	});
	// read 工具按行输出去掉了 \r，模型复制出来的 oldText 因此是 LF；CRLF 文件直接按原文
	// 匹配会找不到。统一在 LF 视图上定位，写回时恢复文件本来的行尾。
	const eol = original.includes("\r\n") ? "\r\n" : "\n";
	const normalized = original.replace(/\r\n/g, "\n");
	const edits = args.edits as Array<{ oldText: string; newText: string }>;
	const ranges = edits
		.map((edit) => {
			const oldText = edit.oldText.replace(/\r\n/g, "\n");
			const newText = edit.newText.replace(/\r\n/g, "\n");
			if (oldText.length === 0) throw new Error("Edit targets cannot be empty");
			const start = normalized.indexOf(oldText);
			const preview = oldText.replace(/\n/g, "\\n").slice(0, 80);
			if (start < 0) throw new Error(`Edit target not found: ${preview}`);
			const occurrences = countOccurrences(normalized, oldText);
			if (occurrences > 1)
				throw new Error(`Edit target occurs ${occurrences} times; include more surrounding context: ${preview}`);
			return { start, end: start + oldText.length, replacement: newText };
		})
		.sort((left, right) => left.start - right.start);

	for (let index = 1; index < ranges.length; index += 1) {
		if (ranges[index]!.start < ranges[index - 1]!.end) throw new Error("Edit ranges must not overlap");
	}
	let updated = normalized;
	for (const range of [...ranges].reverse()) {
		updated = `${updated.slice(0, range.start)}${range.replacement}${updated.slice(range.end)}`;
	}
	if (eol === "\r\n") updated = updated.replace(/\n/g, "\r\n");
	await atomicWriteFile(path, updated);
	return { content: `Updated ${basename(path)} (${edits.length} replacement(s)).`, changedPaths: [path] };
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index >= 0) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}
