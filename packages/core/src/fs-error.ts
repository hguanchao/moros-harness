/** 文件系统错误码判定；仓库内多处读写需要区分「目标不存在」与真正的 I/O 失败。 */

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** 目标文件或目录不存在（ENOENT）。 */
export function isMissingPath(error: unknown): boolean {
	return hasCode(error, "ENOENT");
}

/** 路径不存在，或路径中间有一段是文件（ENOENT / ENOTDIR）。 */
export function isNotFound(error: unknown): boolean {
	return isMissingPath(error) || hasCode(error, "ENOTDIR");
}

/** 目标是目录，而调用方按文件读写（EISDIR）。 */
export function isDirectoryError(error: unknown): boolean {
	return hasCode(error, "EISDIR");
}

/** 排他创建时目标已存在（EEXIST）。 */
export function isExists(error: unknown): boolean {
	return hasCode(error, "EEXIST");
}
