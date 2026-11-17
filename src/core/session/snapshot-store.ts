import { createHash, randomUUID } from "node:crypto";
import { deflate, inflate } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isMissingPath, isExists } from "#src/core/fs-error.ts";

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

export interface SnapshotFile {
	path: string;
	op: "create" | "modify" | "delete";
	before: string | null;
	after: string | null;
}

export interface SnapshotRecord {
	id: string;
	phase: "before" | "after" | "rollback";
	seq: number;
	files: SnapshotFile[];
	/** 记录写入时间（索引行里的 ts）；旧索引缺失时为空。 */
	ts?: string;
}

/** 内容寻址对象库；对象先写临时文件，再原子重命名到哈希路径。 */
export class SnapshotStore {
	readonly #root: string;
	readonly #now: () => Date;
	readonly #onRecoveryWarning: (message: string) => void;

	constructor(
		root: string,
		now: () => Date = () => new Date(),
		options: { onRecoveryWarning?: (message: string) => void } = {},
	) {
		this.#root = root;
		this.#now = now;
		this.#onRecoveryWarning = options.onRecoveryWarning ?? (() => undefined);
	}

	async put(content: Uint8Array): Promise<string> {
		const data = Buffer.from(content);
		const hash = createHash("sha256").update(data).digest("hex");
		const target = this.#objectPath(hash);
		await mkdir(dirname(target), { recursive: true });
		try {
			await readFile(target);
			return hash;
		} catch (error) {
			if (!isMissingPath(error)) throw error;
		}
		const temporary = `${target}.${randomUUID()}.tmp`;
		const compressed = await deflateAsync(data);
		const file = await open(temporary, "wx");
		try {
			await file.writeFile(compressed);
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await rename(temporary, target);
		} catch (error) {
			if (!isExists(error)) throw error;
			await rm(temporary, { force: true });
		}
		return hash;
	}

	async get(hash: string): Promise<Buffer> {
		if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid snapshot hash");
		const compressed = await readFile(this.#objectPath(hash));
		const content = await inflateAsync(compressed);
		const actual = createHash("sha256").update(content).digest("hex");
		if (actual !== hash) throw new Error(`Snapshot object integrity check failed: ${hash}`);
		return content;
	}

	async appendRecord(sessionId: string, record: SnapshotRecord): Promise<void> {
		const path = this.#indexPath(sessionId);
		await mkdir(dirname(path), { recursive: true });
		const file = await open(path, "a");
		try {
			await file.writeFile(`${JSON.stringify({ ...record, ts: this.#now().toISOString() })}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
	}

	/**
	 * 读取会话的快照索引记录（逐行容错，ADR-15）。
	 *
	 * 与 EventStore 的恢复语义对齐但更保守：索引是只读消费的 append-only 文件，
	 * 坏行（崩溃半行、磁盘坏块）跳过并告警，**不改写文件**——坏行之前的检查点仍然
	 * 合法可用，一个坏行不再让该会话全部检查点瘫痪。
	 * @param sessionId 会话 ID。
	 * @returns 解析成功的快照记录（保序）。
	 */
	async readRecords(sessionId: string): Promise<SnapshotRecord[]> {
		let text: string;
		try {
			text = await readFile(this.#indexPath(sessionId), "utf8");
		} catch (error) {
			if (isMissingPath(error)) return [];
			throw error;
		}
		const lines = text.split("\n").filter((line) => line.length > 0);
		const records: SnapshotRecord[] = [];
		lines.forEach((line, index) => {
			try {
				records.push(snapshotRecordSchema(JSON.parse(line)));
			} catch (error) {
				const truncated = index === lines.length - 1 ? " (truncated tail)" : "";
				this.#onRecoveryWarning(
					`Skipped invalid snapshot record at line ${index + 1} of ${sessionId} index${truncated}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
		return records;
	}

	#objectPath(hash: string): string {
		return join(this.#root, "objects", hash.slice(0, 2), hash.slice(2));
	}

	#indexPath(sessionId: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid session id");
		return join(this.#root, "idx", `${sessionId}.jsonl`);
	}
}

function snapshotRecordSchema(value: unknown): SnapshotRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected snapshot object");
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || !Number.isInteger(record.seq) || !Array.isArray(record.files)) {
		throw new Error("Invalid snapshot record");
	}
	if (record.phase !== "before" && record.phase !== "after" && record.phase !== "rollback") {
		throw new Error("Invalid snapshot phase");
	}
	const files = record.files.map((value): SnapshotFile => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid snapshot file entry");
		const file = value as Record<string, unknown>;
		if (typeof file.path !== "string" || (file.op !== "create" && file.op !== "modify" && file.op !== "delete")) {
			throw new Error("Invalid snapshot file path or operation");
		}
		if (file.before !== null && typeof file.before !== "string") throw new Error("Invalid snapshot before hash");
		if (file.after !== null && typeof file.after !== "string") throw new Error("Invalid snapshot after hash");
		return { path: file.path, op: file.op, before: file.before, after: file.after };
	});
	return {
		id: record.id,
		phase: record.phase,
		seq: record.seq as number,
		files,
		...(typeof record.ts === "string" ? { ts: record.ts } : {}),
	};
}
