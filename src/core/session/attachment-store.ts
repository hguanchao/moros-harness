import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "#src/core/atomic-file.ts";

/** 将会话附件以原子写入方式保存到会话目录的 attachments/ 下。 */
export class AttachmentStore {
	/** 保存附件字节；附件 ID 必须由调用方生成且仅含安全文件名字符。 */
	async put(sessionDirectory: string, attachmentId: string, content: Uint8Array): Promise<void> {
		await atomicWriteFile(this.#attachmentPath(sessionDirectory, attachmentId), content);
	}

	/** 读取会话附件；缺失或 ID 非法时抛出错误。 */
	get(sessionDirectory: string, attachmentId: string): Promise<Buffer> {
		return readFile(this.#attachmentPath(sessionDirectory, attachmentId));
	}

	#attachmentPath(sessionDirectory: string, attachmentId: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(attachmentId)) throw new Error("Invalid attachment id");
		return join(sessionDirectory, "attachments", attachmentId);
	}
}
