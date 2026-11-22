import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { summarizeChangeStats, type FileChangeEntry } from "@moros/core/diff/line-diff.ts";

/** 用内容哈希模拟 SnapshotStore.get：哈希即 "sha256:内容" 的映射键。 */
function makeGetter(): {
	get: (hash: string) => Promise<Buffer>;
	hashOf: (content: string) => string;
} {
	const store = new Map<string, Buffer>();
	return {
		hashOf: (content: string) => {
			const hash = createHash("sha256").update(content).digest("hex");
			store.set(hash, Buffer.from(content, "utf8"));
			return hash;
		},
		get: async (hash: string) => {
			const value = store.get(hash);
			if (value === undefined) throw new Error(`Snapshot not found: ${hash}`);
			return value;
		},
	};
}

describe("summarizeChangeStats 会话变更汇总", () => {
	it("按 path 去重：取首个 before 与末个 after 计算净 diff", async () => {
		const { get, hashOf } = makeGetter();
		const v0 = hashOf("a\nb\n");
		const v1 = hashOf("a\nb\nc\n");
		const v2 = hashOf("a\nb\nc\nd\n");
		const entries: FileChangeEntry[] = [
			{ path: "f.txt", before: v0, after: v1 },
			{ path: "f.txt", before: v1, after: v2 },
		];

		// 净变化 v0 -> v2：新增 c、d 两行
		expect(await summarizeChangeStats(entries, get)).toEqual({ files: 1, added: 2, removed: 0 });
	});

	it("新建后删除（before/after 同为 null）不计入文件数", async () => {
		const { get } = makeGetter();
		const entries: FileChangeEntry[] = [{ path: "tmp.txt", before: null, after: null }];
		expect(await summarizeChangeStats(entries, get)).toEqual({ files: 0, added: 0, removed: 0 });
	});

	it("新建文件：before 为 null，统计全部为新增行", async () => {
		const { get, hashOf } = makeGetter();
		const content = hashOf("line1\nline2\n");
		// diffLines 按 splitLines 计行，末尾换行产生一个空行：共 3 行。
		expect(await summarizeChangeStats([{ path: "new.txt", before: null, after: content }], get)).toEqual({
			files: 1,
			added: 3,
			removed: 0,
		});
	});

	it("删除文件：after 为 null，统计全部为删除行", async () => {
		const { get, hashOf } = makeGetter();
		const content = hashOf("line1\nline2\n");
		expect(await summarizeChangeStats([{ path: "old.txt", before: content, after: null }], get)).toEqual({
			files: 1,
			added: 0,
			removed: 3,
		});
	});

	it("多文件累加增删行", async () => {
		const { get, hashOf } = makeGetter();
		const a0 = hashOf("x\n");
		const a1 = hashOf("x\ny\n");
		const b0 = hashOf("p\nq\n");
		const b1 = hashOf("p\n");
		const entries: FileChangeEntry[] = [
			{ path: "a.txt", before: a0, after: a1 },
			{ path: "b.txt", before: b0, after: b1 },
		];
		expect(await summarizeChangeStats(entries, get)).toEqual({ files: 2, added: 1, removed: 1 });
	});

	it("快照缺失的文件被跳过，不影响其他文件统计", async () => {
		const { get, hashOf } = makeGetter();
		const good = hashOf("ok\n");
		const entries: FileChangeEntry[] = [
			{ path: "broken.txt", before: "0".repeat(64), after: good },
			{ path: "good.txt", before: null, after: good },
		];
		expect(await summarizeChangeStats(entries, get)).toEqual({ files: 1, added: 2, removed: 0 });
	});
});
