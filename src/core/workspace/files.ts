import { open, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { resolveSandboxPath } from "#src/core/harness/path-sandbox.ts";

/** 文件树默认忽略的目录；与 glob/grep 工具保持同一集合。 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([".git", ".moros", "node_modules", "dist"]);

/** 单次列目录的条数上限，防止超大目录拖慢渲染进程。 */
const DEFAULT_MAX_ENTRIES = 2_000;

/** 文本预览默认上限 1 MiB；超出部分截断并标注。 */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** 二进制探测窗口。 */
const BINARY_PROBE_BYTES = 8 * 1024;

/** 目录项；path 统一使用 `/` 分隔的项目相对路径。 */
export interface WorkspaceEntry {
	readonly name: string;
	readonly path: string;
	readonly kind: "file" | "directory" | "symlink";
	readonly bytes?: number;
	readonly mtimeMs?: number;
}

export interface ListDirectoryOptions {
	/** 是否包含点文件；默认包含（.git/.moros 仍按目录忽略）。 */
	readonly includeHidden?: boolean;
	readonly maxEntries?: number;
}

export interface ReadTextFileResult {
	readonly path: string;
	readonly bytes: number;
	readonly mtimeMs: number;
	readonly text: string | null;
	readonly binary: boolean;
	readonly truncated: boolean;
}

/** 把操作系统分隔符统一成 `/`，供界面和协议使用。 */
export function toPosixPath(value: string): string {
	return value.replaceAll("\\", "/");
}

/**
 * 列出项目内一个目录的直接子项，按目录优先、名称排序。
 *
 * 所有路径先过沙箱校验，符号链接只标记不展开（避免循环与越界）。忽略目录与点文件
 * 规则在这里统一执行，宿主不需要重复实现。
 * @param projectRoot 工作区根目录。
 * @param relativeDir 相对目录，空串表示根。
 * @param options 隐藏项与条数上限。
 * @throws 目录越界、受保护目录或不可读时抛出错误。
 */
export async function listDirectory(
	projectRoot: string,
	relativeDir = "",
	options: ListDirectoryOptions = {},
): Promise<readonly WorkspaceEntry[]> {
	const absolute = await resolveSandboxPath(projectRoot, relativeDir || ".");
	const entries = await readdir(absolute, { withFileTypes: true });
	const includeHidden = options.includeHidden ?? true;
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const prefix = relativeDir.length > 0 ? `${relativeDir.replace(/\/+$/, "")}/` : "";
	const result: WorkspaceEntry[] = [];
	for (const entry of entries) {
		if (!includeHidden && entry.name.startsWith(".")) continue;
		if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
		const path = `${prefix}${entry.name}`;
		if (entry.isSymbolicLink()) {
			result.push({ name: entry.name, path, kind: "symlink" });
			continue;
		}
		if (entry.isDirectory()) {
			result.push({ name: entry.name, path, kind: "directory" });
			continue;
		}
		if (!entry.isFile()) continue;
		const info = await stat(join(absolute, entry.name)).catch(() => undefined);
		result.push({
			name: entry.name,
			path,
			kind: "file",
			...(info ? { bytes: info.size, mtimeMs: info.mtimeMs } : {}),
		});
		if (result.length >= maxEntries) break;
	}
	return result.sort((left, right) => {
		if (left.kind === "directory" && right.kind !== "directory") return -1;
		if (left.kind !== "directory" && right.kind === "directory") return 1;
		return left.name.localeCompare(right.name, "zh-CN");
	});
}

/**
 * 读取项目内文本文件预览：二进制与超限都降级返回，不抛错。
 *
 * 二进制判定看前 8 KiB 是否含 NUL；超限按 UTF-8 边界截断。真实路径先 realpath，
 * 确保符号链接不能把读取带出工作区。
 * @param projectRoot 工作区根目录。
 * @param relativePath 项目相对路径。
 * @param options maxBytes 覆盖默认上限。
 */
export async function readTextFile(
	projectRoot: string,
	relativePath: string,
	options: { maxBytes?: number } = {},
): Promise<ReadTextFileResult> {
	const absolute = await resolveSandboxPath(projectRoot, relativePath);
	const info = await stat(absolute);
	if (!info.isFile()) throw new Error(`${relativePath} is not a file`);
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const handle = await open(absolute, "r");
	try {
		const probe = Buffer.alloc(Math.min(info.size, BINARY_PROBE_BYTES));
		if (probe.length > 0) await handle.read(probe, 0, probe.length, 0);
		if (probe.includes(0)) {
			return {
				path: relativePath,
				bytes: info.size,
				mtimeMs: info.mtimeMs,
				text: null,
				binary: true,
				truncated: false,
			};
		}
		const readBytes = Math.min(info.size, maxBytes);
		const buffer = Buffer.alloc(readBytes);
		if (readBytes > 0) await handle.read(buffer, 0, readBytes, 0);
		const text = buffer.toString("utf8");
		return {
			path: relativePath,
			bytes: info.size,
			mtimeMs: info.mtimeMs,
			text,
			binary: false,
			truncated: info.size > readBytes,
		};
	} finally {
		await handle.close();
	}
}

/**
 * 读取项目内文件原始字节，供图片/二进制预览。
 * @param projectRoot 工作区根目录。
 * @param relativePath 项目相对路径。
 * @param maxBytes 读取上限，超出截断。
 */
export async function readFileBytes(
	projectRoot: string,
	relativePath: string,
	options: { maxBytes?: number } = {},
): Promise<{ path: string; bytes: number; data: Buffer; truncated: boolean }> {
	const absolute = await resolveSandboxPath(projectRoot, relativePath);
	const info = await stat(absolute);
	if (!info.isFile()) throw new Error(`${relativePath} is not a file`);
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const readBytes = Math.min(info.size, maxBytes);
	const handle = await open(absolute, "r");
	try {
		const data = Buffer.alloc(readBytes);
		if (readBytes > 0) await handle.read(data, 0, readBytes, 0);
		return { path: relativePath, bytes: info.size, data, truncated: info.size > readBytes };
	} finally {
		await handle.close();
	}
}

/** 确认工作区根仍是可访问目录，且 realpath 后仍与传入路径一致。 */
export async function assertWorkspaceRoot(projectRoot: string): Promise<string> {
	const info = await stat(projectRoot);
	if (!info.isDirectory()) throw new Error("Workspace root is not a directory");
	return realpath(projectRoot);
}
