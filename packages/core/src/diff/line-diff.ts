/** 单次 diff 的矩阵单元格上限：约 2000×2000 行，超出后降级为整体替换。 */
const MAX_MATRIX_CELLS = 4_000_000;

/** 上下文行数：与常见 unified diff 一致。 */
const CONTEXT_LINES = 3;

/** 两侧文本的字节上限；更大的文件只按行数降级处理。 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export type DiffLineKind = "equal" | "add" | "remove";

export interface DiffLine {
	readonly kind: DiffLineKind;
	/** 旧文件行号（1 起）；新增行为 undefined。 */
	readonly oldLine?: number;
	/** 新文件行号（1 起）；删除行为 undefined。 */
	readonly newLine?: number;
	readonly text: string;
}

export interface DiffHunk {
	readonly oldStart: number;
	readonly oldCount: number;
	readonly newStart: number;
	readonly newCount: number;
	readonly lines: readonly DiffLine[];
}

export interface DiffResult {
	readonly hunks: readonly DiffHunk[];
	readonly added: number;
	readonly removed: number;
	/** 任一侧是二进制或超过文本上限时为 true。 */
	readonly binary: boolean;
	/** 行数过大而退化为整体替换。 */
	readonly degraded: boolean;
	readonly beforeBytes: number;
	readonly afterBytes: number;
}

/**
 * 计算两份文本的行级差异（LCS，带前后缀裁剪）。
 *
 * 只做展示用途：超大输入降级为「整段删除 + 整段新增」，不抛错；二进制返回空 hunk 并
 * 标记 binary。结果按统一 diff 习惯切成带 3 行上下文的 hunk。
 * @param before 旧文本；文件新建时为 null。
 * @param after 新文本；文件删除时为 null。
 * @param options 二进制标记与字节数由调用方提供，用于展示。
 */
export function diffLines(
	before: string | null,
	after: string | null,
	options: { readonly binary?: boolean; readonly beforeBytes?: number; readonly afterBytes?: number } = {},
): DiffResult {
	const beforeText = before ?? "";
	const afterText = after ?? "";
	const beforeBytes = options.beforeBytes ?? Buffer.byteLength(beforeText, "utf8");
	const afterBytes = options.afterBytes ?? Buffer.byteLength(afterText, "utf8");
	if (options.binary === true) {
		return { hunks: [], added: 0, removed: 0, binary: true, degraded: false, beforeBytes, afterBytes };
	}
	const beforeLines = splitLines(beforeText);
	const afterLines = splitLines(afterText);
	const ops = computeOps(beforeLines, afterLines);
	const added = ops.filter((op) => op.kind === "add").length;
	const removed = ops.filter((op) => op.kind === "remove").length;
	return {
		hunks: buildHunks(ops),
		added,
		removed,
		binary: false,
		degraded: ops.some((op) => op.degraded),
		beforeBytes,
		afterBytes,
	};
}

/** 单个文件的净变更输入（哈希来自 file.changed 事件 payload）。 */
export interface FileChangeEntry {
	readonly path: string;
	/** 该路径首次变更前的快照哈希；新建文件为 null。 */
	readonly before: string | null;
	/** 该路径末次变更后的快照哈希；删除文件为 null。 */
	readonly after: string | null;
}

/** 会话级变更汇总：按文件去重的净增删行统计。 */
export interface ChangeSummary {
	readonly files: number;
	readonly added: number;
	readonly removed: number;
}

/**
 * 汇总会话级净变更：按 path 去重（首个 before → 末个 after），逐文件计算增删行并累加。
 *
 * 纯逻辑，快照读取通过 `get` 注入，便于测试。单个文件快照缺失/损坏时跳过，不影响整体；
 * 最终内容回到原样（before === after）的文件不计入。
 */
export async function summarizeChangeStats(
	entries: readonly FileChangeEntry[],
	get: (hash: string) => Promise<Buffer>,
): Promise<ChangeSummary> {
	const grouped = new Map<string, { before: string | null; after: string | null }>();
	for (const entry of entries) {
		const existing = grouped.get(entry.path);
		if (existing === undefined) grouped.set(entry.path, { before: entry.before, after: entry.after });
		else existing.after = entry.after;
	}
	let files = 0;
	let added = 0;
	let removed = 0;
	for (const { before, after } of grouped.values()) {
		if (before === after) continue;
		try {
			const beforeBuffer = before === null ? null : await get(before);
			const afterBuffer = after === null ? null : await get(after);
			const beforeText = decodeDiffText(beforeBuffer);
			const afterText = decodeDiffText(afterBuffer);
			const diff = diffLines(beforeText.text, afterText.text, {
				binary: beforeText.binary || afterText.binary,
				beforeBytes: beforeText.bytes,
				afterBytes: afterText.bytes,
			});
			files += 1;
			added += diff.added;
			removed += diff.removed;
		} catch {
			// 单个快照损坏不拖垮整体统计。
		}
	}
	return { files, added, removed };
}

interface Operation extends DiffLine {
	readonly degraded: boolean;
}

/**
 * 生成编辑序列：先裁掉公共前后缀，再对中间段做 LCS。
 * 矩阵超限时中间段直接记为「全删 + 全增」。
 */
function computeOps(before: readonly string[], after: readonly string[]): readonly Operation[] {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix += 1;
	}

	const ops: Operation[] = [];
	for (let index = 0; index < prefix; index += 1) {
		ops.push({ kind: "equal", oldLine: index + 1, newLine: index + 1, text: before[index] ?? "", degraded: false });
	}

	const beforeMiddle = before.slice(prefix, before.length - suffix);
	const afterMiddle = after.slice(prefix, after.length - suffix);
	const degraded = beforeMiddle.length * afterMiddle.length > MAX_MATRIX_CELLS;
	if (degraded) {
		for (const [offset, line] of beforeMiddle.entries()) {
			ops.push({ kind: "remove", oldLine: prefix + offset + 1, text: line, degraded: true });
		}
		for (const [offset, line] of afterMiddle.entries()) {
			ops.push({ kind: "add", newLine: prefix + offset + 1, text: line, degraded: true });
		}
	} else {
		ops.push(...lcsOps(beforeMiddle, afterMiddle, prefix));
	}

	for (let index = 0; index < suffix; index += 1) {
		const oldIndex = before.length - suffix + index;
		const newIndex = after.length - suffix + index;
		ops.push({
			kind: "equal",
			oldLine: oldIndex + 1,
			newLine: newIndex + 1,
			text: before[oldIndex] ?? "",
			degraded: false,
		});
	}
	return ops.filter((op, index, all) => {
		if (index === 0) return true;
		// 新建/删除末尾空行时 split 会留下一个空串；保留首尾真实行，去掉纯尾随换行伪行
		const previous = all[index - 1];
		return !(op.text === "" && previous?.text === "" && op.kind === previous.kind);
	});
}

/** 标准 LCS 回溯；行号从 1 起，offset 是裁剪前缀长度。 */
function lcsOps(before: readonly string[], after: readonly string[], offset: number): readonly Operation[] {
	const rows = before.length;
	const cols = after.length;
	const width = cols + 1;
	const table = new Uint32Array((rows + 1) * width);
	for (let row = rows - 1; row >= 0; row -= 1) {
		for (let col = cols - 1; col >= 0; col -= 1) {
			table[row * width + col] =
				before[row] === after[col]
					? 1 + (table[(row + 1) * width + col + 1] ?? 0)
					: Math.max(table[(row + 1) * width + col] ?? 0, table[row * width + col + 1] ?? 0);
		}
	}
	const ops: Operation[] = [];
	let row = 0;
	let col = 0;
	while (row < rows && col < cols) {
		if (before[row] === after[col]) {
			ops.push({
				kind: "equal",
				oldLine: offset + row + 1,
				newLine: offset + col + 1,
				text: before[row] ?? "",
				degraded: false,
			});
			row += 1;
			col += 1;
		} else if ((table[(row + 1) * width + col] ?? 0) >= (table[row * width + col + 1] ?? 0)) {
			ops.push({ kind: "remove", oldLine: offset + row + 1, text: before[row] ?? "", degraded: false });
			row += 1;
		} else {
			ops.push({ kind: "add", newLine: offset + col + 1, text: after[col] ?? "", degraded: false });
			col += 1;
		}
	}
	while (row < rows) {
		ops.push({ kind: "remove", oldLine: offset + row + 1, text: before[row] ?? "", degraded: false });
		row += 1;
	}
	while (col < cols) {
		ops.push({ kind: "add", newLine: offset + col + 1, text: after[col] ?? "", degraded: false });
		col += 1;
	}
	return ops;
}

/** 把操作序列切成带上下文的 hunk；无变化的片段直接省略。 */
function buildHunks(ops: readonly Operation[]): readonly DiffHunk[] {
	const changed = ops.map((op) => op.kind !== "equal");
	if (!changed.some(Boolean)) return [];
	const keep = new Array<boolean>(ops.length).fill(false);
	for (const [index, isChanged] of changed.entries()) {
		if (!isChanged) continue;
		for (
			let start = Math.max(0, index - CONTEXT_LINES);
			start <= Math.min(ops.length - 1, index + CONTEXT_LINES);
			start += 1
		) {
			keep[start] = true;
		}
	}

	const hunks: DiffHunk[] = [];
	let index = 0;
	while (index < ops.length) {
		if (!keep[index]) {
			index += 1;
			continue;
		}
		const start = index;
		while (index < ops.length && keep[index]) index += 1;
		const lines = ops.slice(start, index);
		const oldNumbers = lines.flatMap((line) => (line.oldLine === undefined ? [] : [line.oldLine]));
		const newNumbers = lines.flatMap((line) => (line.newLine === undefined ? [] : [line.newLine]));
		hunks.push({
			oldStart: oldNumbers[0] ?? 0,
			oldCount: oldNumbers.length,
			newStart: newNumbers[0] ?? 0,
			newCount: newNumbers.length,
			lines: lines.map(({ kind, oldLine, newLine, text }) => ({
				kind,
				...(oldLine === undefined ? {} : { oldLine }),
				...(newLine === undefined ? {} : { newLine }),
				text,
			})),
		});
	}
	return hunks;
}

/** 按 LF 切行；CRLF 归一成 LF。空文本返回空数组。 */
function splitLines(text: string): readonly string[] {
	if (text.length === 0) return [];
	return text.replaceAll("\r\n", "\n").split("\n");
}

/** 文本是否像二进制：前 8 KiB 含 NUL。 */
export function looksBinary(buffer: Buffer | null): boolean {
	return buffer !== null && buffer.subarray(0, 8 * 1024).includes(0);
}

/** 把 Buffer 解码为 diff 文本；超限或二进制时返回 null。 */
export function decodeDiffText(
	buffer: Buffer | null,
	options: { maxBytes?: number } = {},
): { text: string | null; binary: boolean; bytes: number } {
	const bytes = buffer?.byteLength ?? 0;
	if (buffer === null) return { text: null, binary: false, bytes };
	if (looksBinary(buffer)) return { text: null, binary: true, bytes };
	const limit = options.maxBytes ?? MAX_TEXT_BYTES;
	return { text: buffer.subarray(0, limit).toString("utf8"), binary: false, bytes };
}
