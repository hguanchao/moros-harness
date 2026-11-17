import { basename } from "node:path";
import { stat } from "node:fs/promises";

import { z } from "zod";

import type { ToolDefinition, ToolResult } from "#src/core/harness/types.ts";
import { asToolArguments } from "#src/core/tools/tool-utils.ts";
import { atomicWriteFile } from "#src/core/atomic-file.ts";
import { isMissingPath } from "#src/core/fs-error.ts";

const WRITE_SCHEMA = z.object({
	path: z.string().min(1).describe("Project file path to create or overwrite."),
	content: z.string().describe("Complete file content to write."),
});

/**
 * 建立完整写入文件工具。
 * @returns 通过 Harness 快照后执行文件写入的工具定义。
 */
export function createWriteTool(): ToolDefinition {
	return {
		name: "write",
		description: "Create or overwrite a project file with the supplied content.",
		schema: WRITE_SCHEMA,
		resource: "write",
		paths: (args) => [asToolArguments(args).path as string],
		applyResolvedPaths: (args, paths) => ({ ...asToolArguments(args), path: paths[0] }),
		execute: async (args) => writeFileTool(asToolArguments(args)),
	};
}

async function writeFileTool(args: Record<string, unknown>): Promise<ToolResult> {
	const path = args.path as string;
	const content = args.content as string;
	// 目标可能是还不存在的叶子（由 atomicWriteFile 连同父目录创建），只拦「已有目录」这种情况
	const info = await stat(path).catch((error: unknown) => {
		if (isMissingPath(error)) return undefined;
		throw error;
	});
	if (info?.isDirectory()) throw new Error("Path is a directory; write targets a file");
	await atomicWriteFile(path, content);
	return {
		content: `Wrote ${basename(path)} (${content.length} characters).`,
		changedPaths: [path],
	};
}
