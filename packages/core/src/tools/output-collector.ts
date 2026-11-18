import { randomUUID } from "node:crypto";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface OutputCollectorOptions {
	readonly threshold: number;
	readonly directory?: string;
	readonly name: string;
	readonly maxBytes?: number;
}

export interface CollectedOutput {
	readonly text: string;
	readonly spillPath?: string;
	readonly truncated: boolean;
}

/** 低于阈值时在内存中收集输出，超过阈值后串行追加到 spill 文件。 */
export class OutputCollector {
	readonly #options: OutputCollectorOptions;
	readonly #maxBytes: number;
	#text = "";
	#preview = "";
	#byteLength = 0;
	#spillPath: string | undefined;
	#file: FileHandle | undefined;
	#truncated = false;
	#pending: Promise<void> = Promise.resolve();

	constructor(options: OutputCollectorOptions) {
		this.#options = options;
		this.#maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
	}

	/** 追加一个输出块，并按序写入已打开的 spill 文件。 */
	async write(chunk: string): Promise<void> {
		const operation = this.#pending.then(() => this.#writeChunk(chunk));
		this.#pending = operation.catch(() => undefined);
		await operation;
	}

	/** 完成输出收集并返回模型可见文本。 */
	async finish(): Promise<CollectedOutput> {
		await this.#pending;
		if (this.#file) {
			await this.#file.sync();
			await this.#file.close();
			this.#file = undefined;
			return {
				text: `Full output saved to ${this.#spillPath}\nPreview (first 1KB):\n${this.#preview}${this.#truncated ? "\n[Output truncated at the configured safety limit.]" : ""}`,
				...(this.#spillPath ? { spillPath: this.#spillPath } : {}),
				truncated: this.#truncated,
			};
		}
		return { text: this.#text, truncated: this.#truncated };
	}

	async #writeChunk(chunk: string): Promise<void> {
		if (!chunk || this.#truncated) return;
		const remaining = this.#maxBytes - this.#byteLength;
		const buffer = Buffer.from(chunk, "utf8");
		const accepted = buffer.length > remaining ? buffer.subarray(0, Math.max(0, remaining)) : buffer;
		const value = accepted.toString("utf8");
		this.#byteLength += accepted.length;
		// 预览按字节封顶：文案承诺的是 1KB，按 UTF-16 码元截断在中文下会到 2–4KB
		this.#preview = Buffer.from(this.#preview + value, "utf8")
			.subarray(0, 1024)
			.toString("utf8");
		if (buffer.length > remaining) this.#truncated = true;

		if (
			!this.#file &&
			this.#options.threshold > 0 &&
			this.#byteLength > this.#options.threshold &&
			this.#options.directory
		) {
			const safeName = this.#options.name.replace(/[^A-Za-z0-9_-]/g, "_");
			this.#spillPath = join(this.#options.directory, `${safeName}-${randomUUID()}.log`);
			await mkdir(dirname(this.#spillPath), { recursive: true });
			this.#file = await open(this.#spillPath, "wx");
			await this.#file.writeFile(this.#text, "utf8");
			this.#text = "";
		}
		if (this.#file) await this.#file.writeFile(accepted);
		else this.#text += value;
	}
}
