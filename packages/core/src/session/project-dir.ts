import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * 归一化项目根路径：resolve 后在 Windows 上整体小写。
 *
 * 会话目录名由该结果派生；Windows 文件系统大小写不敏感，同一项目因盘符或目录大小写的
 * 写法差异必须落到同一个目录，否则会产生两份互不相见的会话记录。
 */
export function normalizeProjectRoot(root: string): string {
	const resolved = resolve(root);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 项目目录名：归一化路径的 sha256 前 16 位 hex，会话目录（`sessions/<ph>`）据此派生。
 *
 * 刻意不可逆——目录名不还原路径，明文路径保留在每个会话事件流的 `session.created` 里。
 * 确定性派生让启动时可以直接算出项目目录，不需要扫描全部会话。
 */
export function projectDirName(root: string): string {
	return createHash("sha256").update(normalizeProjectRoot(root)).digest("hex").slice(0, 16);
}
