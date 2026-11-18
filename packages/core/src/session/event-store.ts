import { mkdir, open, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";

import { EventSchema, type EventRecord, type NewEvent } from "../events/schema.ts";
import { isMissingPath } from "../fs-error.ts";

export interface EventStoreOptions {
	now?: () => Date;
	onRecoveryWarning?: (message: string) => void;
}

/** 仅追加 JSONL 事件，并在恢复时裁去崩溃留下的不完整尾行。 */
export class EventStore {
	readonly #path: string;
	readonly #now: () => Date;
	readonly #onRecoveryWarning: (message: string) => void;
	#events: EventRecord[] = [];
	#loaded: Promise<void> | undefined;
	#pending: Promise<void> = Promise.resolve();
	readonly #listeners = new Set<(event: EventRecord) => void>();

	constructor(path: string, options: EventStoreOptions = {}) {
		this.#path = path;
		this.#now = options.now ?? (() => new Date());
		this.#onRecoveryWarning = options.onRecoveryWarning ?? (() => undefined);
	}

	get lastSeq(): number {
		return this.#events.at(-1)?.seq ?? 0;
	}

	async load(): Promise<readonly EventRecord[]> {
		if (!this.#loaded) {
			this.#loaded = this.#loadFromDisk();
		}
		await this.#loaded;
		return this.#events;
	}

	async #loadFromDisk(): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		let bytes: Buffer;
		try {
			bytes = await readFile(this.#path);
		} catch (error) {
			if (isMissingPath(error)) return;
			throw error;
		}

		const lastNewline = bytes.lastIndexOf(0x0a);
		const completeLength = lastNewline + 1;
		if (completeLength !== bytes.length) {
			const discardedBytes = bytes.length - completeLength;
			await truncate(this.#path, completeLength);
			bytes = bytes.subarray(0, completeLength);
			this.#onRecoveryWarning(`Truncated ${discardedBytes} incomplete trailing event bytes in ${this.#path}`);
		}

		const lines = bytes
			.toString("utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		for (const [index, line] of lines.entries()) {
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch (error) {
				throw new Error(`Invalid event JSON at line ${index + 1}`, { cause: error });
			}
			const event = EventSchema.parse(raw);
			const expected = index + 1;
			if (event.seq !== expected) {
				throw new Error(`Invalid event sequence at line ${index + 1}: expected ${expected}, received ${event.seq}`);
			}
			this.#events.push(event);
		}
	}

	async append(input: NewEvent): Promise<EventRecord> {
		let result!: EventRecord;
		const operation = this.#pending.then(async () => {
			await this.load();
			result = EventSchema.parse({ ...input, seq: this.lastSeq + 1, ts: input.ts ?? this.#now().toISOString() });
			const file = await open(this.#path, "a");
			try {
				await file.writeFile(`${JSON.stringify(result)}\n`, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			this.#events.push(result);
			for (const listener of [...this.#listeners]) listener(result);
		});
		this.#pending = operation.catch(() => undefined);
		await operation;
		return result;
	}

	/**
	 * 订阅实时事件流；回调在事件成功落盘并进入内存序列后被调用，按追加次序送达。
	 * @param listener 接收每条新事件的回调。
	 * @returns 取消订阅函数，可重复调用。
	 */
	subscribe(listener: (event: EventRecord) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async read(options: { fromSeq?: number; toSeq?: number } = {}): Promise<readonly EventRecord[]> {
		await this.load();
		return this.#events.filter(
			(event) =>
				(options.fromSeq === undefined || event.seq >= options.fromSeq) &&
				(options.toSeq === undefined || event.seq <= options.toSeq),
		);
	}

	/**
	 * 分页读取：取 `beforeSeq` 之前最近的 `limit` 条（不含该 seq），按 seq 升序返回。
	 * 用于界面先加载尾部、再向上翻历史，避免一次全量读入。
	 * @param options beforeSeq 上界（缺省为流末尾之后）；limit 1~500，缺省 200。
	 */
	async readPage(options: { beforeSeq?: number; limit?: number } = {}): Promise<readonly EventRecord[]> {
		await this.load();
		const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
		const end = options.beforeSeq ?? this.lastSeq + 1;
		const eligible = this.#events.filter((event) => event.seq < end);
		return eligible.slice(Math.max(0, eligible.length - limit));
	}
}
