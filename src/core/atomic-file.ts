import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 以同目录临时文件 + rename 原子替换目标文件。
 *
 * 直接写目标文件在崩溃或断电时会留下半截内容；先写临时名、fsync 落盘再 rename，读者
 * 要么看到旧内容，要么看到完整的新内容。临时文件以排他标志创建，避免并发互相覆盖。
 */
export async function atomicWriteFile(path: string, content: string | Uint8Array): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	try {
		const file = await open(temporary, "wx");
		try {
			await file.writeFile(content);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
