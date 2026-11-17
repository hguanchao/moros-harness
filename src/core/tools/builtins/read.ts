import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

import type { ToolDefinition, ToolResult } from "#src/core/harness/types.ts";
import { asToolArguments } from "#src/core/tools/tool-utils.ts";
import { isMissingPath } from "#src/core/fs-error.ts";

const READ_SCHEMA = z.object({
	path: z.string().min(1).describe("Project-relative or absolute file path."),
	offset: z
		.number()
		.int()
		.nonnegative()
		.default(0)
		.describe("Zero-based line offset to start from; returned lines are prefixed with 1-based line numbers."),
	limit: z.number().int().positive().max(20_000).default(1000).describe("Maximum number of lines to return."),
});
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

/**
 * 建立读取文件工具定义。
 * @returns 只读取文件、不执行权限判断的工具定义。
 */
export function createReadTool(): ToolDefinition {
	return {
		name: "read",
		description:
			"Read a project text file, optionally restricted to a line range. Images and binary files return a short description instead of content.",
		schema: READ_SCHEMA,
		resource: "read",
		paths: (args) => [asToolArguments(args).path as string],
		applyResolvedPaths: (args, paths) => ({ ...asToolArguments(args), path: paths[0] }),
		execute: async (args) => readFileTool(asToolArguments(args)),
	};
}

async function readFileTool(args: Record<string, unknown>): Promise<ToolResult> {
	const path = args.path as string;
	const info = await stat(path).catch((error: unknown) => {
		if (isMissingPath(error)) throw new Error(`Path does not exist: ${path}`);
		throw error;
	});
	if (info.isDirectory()) throw new Error("Path is a directory; use glob or grep to list or search it");
	if (info.size === 0) return { content: "(empty file)" };
	if (info.size > MAX_FILE_BYTES) {
		throw new Error(
			`File is ${info.size} bytes, over the ${MAX_FILE_BYTES}-byte read limit; use grep to locate content`,
		);
	}

	const imageType = IMAGE_TYPES[extname(path).toLowerCase()];
	if (imageType !== undefined) {
		// 工具结果目前是纯文本，图片还不作为多模态部件回传；给出类型与体积，模型据此决定下一步。
		return { content: `Image file (${imageType}, ${info.size} bytes): ${basename(path)}` };
	}
	if (await startsBinary(path)) {
		return { content: `Binary file (${info.size} bytes); inspect it with the shell` };
	}

	const offset = args.offset as number;
	const limit = args.limit as number;
	const selected: string[] = [];
	let total = 0;
	// 逐行流式读取：大文件（含 spill 输出）不需要整份进内存，也仍能数出总行数
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const raw of lines) {
			// UTF-8 BOM 不是正文，留在首行会让模型复制出带不可见字符的 oldText
			const line = total === 0 ? raw.replace(/^\uFEFF/, "") : raw;
			total += 1;
			if (total > offset && selected.length < limit) selected.push(line);
		}
	} finally {
		lines.close();
		stream.close();
	}

	// 空结果与「没有内容」在内容上无法区分：显式给一句提示，模型不必猜工具是不是失败了
	if (offset >= total) return { content: `(no content: offset ${offset} is past the end of a ${total}-line file)` };

	const end = Math.min(offset + limit, total);
	// 行号列按总行数补宽：制表符因此每行落在同一列，TUI 与终端里的正文对齐
	const numberWidth = String(total).length;
	const content = selected
		.map((line, index) => `${String(offset + index + 1).padStart(numberWidth)}\t${line}`)
		.join("\n");
	// 截断提示：不给脚注时模型会把 limit 当成文件结尾，后半段永远读不到
	return {
		content:
			end < total
				? `${content}\n\n[Showing lines ${offset + 1}-${end} of ${total}. Use offset=${end} to continue.]`
				: content,
	};
}

/** 看文件头部有没有 NUL，判断是否二进制；只读 8KB，不加载全文。 */
async function startsBinary(path: string): Promise<boolean> {
	const handle = await open(path, "r");
	try {
		const sample = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
		return sample.subarray(0, bytesRead).includes(0);
	} finally {
		await handle.close();
	}
}
