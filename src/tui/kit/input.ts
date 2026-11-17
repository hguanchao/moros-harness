import { characterWidth, displayWidth, graphemes, truncateToWidth, type Theme } from "#src/tui/term/index.ts";

/**
 * 单行/多行输入框的排版与光标几何。
 *
 * 折行规则只有一套：显式换行各占一行，一个逻辑行超过可用宽度时按显示宽度软换行，断点只
 * 落在字素簇之间。`inputMetrics` 只留光标周围若干行（输入框高度有限），`inputRowSpans`
 * 给出整段输入的可见行——上下键移动要知道全局行号。
 */

/** 首行提示符与续行缩进。两者等宽，正文因此始终对齐。 */
const PROMPT = " › ";
const CONTINUATION = "   ";
/** 默认最多同时显示几行；超出后围绕光标滚动。 */
const DEFAULT_MAX_LINES = 6;

/** 输入框里的一行。 */
export interface InputLineView {
	/** 行首的提示符或缩进，已按可用宽度截断 */
	readonly prefix: string;
	/** 可见正文 */
	readonly text: string;
	/** 正文开头属于斜杠命令的字素数；0 表示这一行没有命令 */
	readonly commandEnd: number;
}

/** 一次输入框排版的结果。 */
export interface InputMetrics {
	/** 光标所在行的提示符 */
	readonly prefix: string;
	/** 光标所在行的可见正文 */
	readonly text: string;
	/** 光标所在列（1 基），可直接用于终端定位 */
	readonly column: number;
	/** 实际显示的行 */
	readonly lines: readonly InputLineView[];
	/** 光标在 `lines` 里的下标 */
	readonly row: number;
}

/** 输入拆行后的可视行在原文里的偏移。 */
export interface InputRowSpan {
	readonly start: number;
	readonly end: number;
}

/** 软换行后的一段：偏移是 UTF-16 下标，`*Char` 是字素下标。 */
interface Segment {
	readonly start: number;
	readonly end: number;
	readonly startChar: number;
	readonly endChar: number;
}

/**
 * 排版一个输入框。
 *
 * @param value 输入内容
 * @param cursor 光标偏移；越界时夹到内容末尾
 * @param width 输入框总列宽（含提示符）
 * @param options 命令长度（用于着色）与最多显示行数
 */
export function inputMetrics(
	value: string,
	cursor: number,
	width: number,
	options: { readonly commandLength?: number | undefined; readonly maxLines?: number | undefined } = {},
): InputMetrics {
	const columns = Math.max(0, width);
	const commandLength = options.commandLength ?? 0;
	const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
	const logical = value.split("\n");
	const cursorAt = Math.min(Math.max(0, cursor), value.length);

	let lineIndex = 0;
	let offset = cursorAt;
	while (lineIndex < logical.length - 1 && offset > (logical[lineIndex]?.length ?? 0)) {
		offset -= (logical[lineIndex]?.length ?? 0) + 1;
		lineIndex += 1;
	}
	offset = Math.min(offset, logical[lineIndex]?.length ?? 0);

	const textWidth = Math.max(0, columns - displayWidth(CONTINUATION) - 1);
	const lines: InputLineView[] = [];
	let cursorLine: InputLineView = { prefix: "", text: "", commandEnd: 0 };
	let cursorRow = 0;
	let cursorPrefixWidth = 0;
	let cursorWidth = 0;

	for (let index = 0; index < logical.length; index += 1) {
		const text = logical[index] ?? "";
		const segments = wrapLine(text, textWidth);
		const cursorSegment = index === lineIndex ? segmentAt(segments, offset) : -1;

		for (let part = 0; part < segments.length; part += 1) {
			const segment = segments[part] as Segment;
			// 整段输入的第一行带提示符；显式换行与软换行的续行都用等宽缩进，正文对齐
			const prefix = truncateToWidth(lines.length === 0 ? PROMPT : CONTINUATION, Math.max(0, columns - 1));
			const prefixWidth = displayWidth(prefix);
			// 段已按宽度切好，再截一次只为兜住「单个字素比整行还宽」：让它溢出会让终端自己
			// 折行，后续每一行的坐标都会错位
			const shown = truncateToWidth(text.slice(segment.start, segment.end), textWidth);
			const commandEnd = index === 0 ? Math.max(0, Math.min(commandLength, segment.endChar) - segment.startChar) : 0;
			const line: InputLineView = { prefix, text: shown, commandEnd };
			if (part === cursorSegment) {
				cursorLine = line;
				cursorRow = lines.length;
				cursorPrefixWidth = prefixWidth;
				cursorWidth = textWidth <= 0 ? 0 : displayWidth(text.slice(segment.start, offset));
			}
			lines.push(line);
		}
	}

	const start = Math.max(0, cursorRow - (maxLines - 1));
	return {
		prefix: cursorLine.prefix,
		text: cursorLine.text,
		column: Math.min(Math.max(1, columns), cursorPrefixWidth + cursorWidth + 1),
		lines: lines.slice(start, start + maxLines),
		row: cursorRow - start,
	};
}

/**
 * 把输入拆成全部可视行。
 *
 * 与 `inputMetrics` 共用同一套折行规则，但返回整段输入——上下键移动要知道全局行号，
 * 不能只看光标周围那几行。
 */
export function inputRowSpans(value: string, width: number): readonly InputRowSpan[] {
	const columns = Math.max(0, width);
	const textWidth = Math.max(0, columns - displayWidth(CONTINUATION) - 1);
	const rows: InputRowSpan[] = [];
	let offset = 0;
	for (const line of value.split("\n")) {
		for (const segment of wrapLine(line, textWidth)) {
			rows.push({ start: offset + segment.start, end: offset + segment.end });
		}
		offset += line.length + 1;
	}
	return rows;
}

/** 输入框的总行数：上下边框各一行，中间是可见输入行。 */
export function inputHeight(value: string, width: number, maxLines?: number): number {
	const limit = Math.max(1, maxLines ?? DEFAULT_MAX_LINES);
	const spans = inputRowSpans(value, width).length;
	return 2 + Math.min(limit, Math.max(1, spans));
}

/**
 * 画一个输入框：上下两条整宽横线，中间是提示符与折行后的正文。
 *
 * 横线不带拐角——输入框在界面上是贴边的一条，不是独立卡片。焦点只影响颜色，不改变宽度，
 * 光标列因此不受选中状态影响。
 */
export function inputLines(
	node: {
		readonly value: string;
		readonly cursor: number;
		readonly focused: boolean;
		readonly commandLength?: number | undefined;
		readonly maxLines?: number | undefined;
	},
	width: number,
	theme: Theme,
): readonly string[] {
	const columns = Math.max(0, width);
	const frame = node.focused ? theme.accent : theme.border;
	const metrics = inputMetrics(node.value, node.cursor, columns, {
		commandLength: node.commandLength ?? 0,
		maxLines: node.maxLines,
	});
	const rule = `${frame}${"─".repeat(columns)}${theme.reset}`;
	const rows = metrics.lines.map((line) => {
		const prefix = `${frame}${line.prefix}${theme.reset}`;
		const chars = graphemes(line.text);
		// 只换颜色不改宽度：光标列与折行结果都不受着色影响
		const command = line.commandEnd <= 0 ? "" : chars.slice(0, line.commandEnd).join("");
		const rest = chars.slice(Math.max(0, line.commandEnd)).join("");
		const body = command.length === 0 ? rest : `${frame}${command}${theme.reset}${rest}`;
		const used = displayWidth(line.prefix) + displayWidth(line.text);
		return `${prefix}${body}${" ".repeat(Math.max(0, columns - used))}`;
	});
	return [rule, ...rows, rule];
}

/**
 * 把一个逻辑行按显示宽度切成若干段。
 *
 * 段边界只落在字素簇之间：宽字符、组合序列与 emoji 被劈开会在终端里错位。单个字素本身比
 * 整行还宽时也让它独占一段，否则原地反复切不开。
 */
function wrapLine(text: string, limit: number): readonly Segment[] {
	const chars = graphemes(text);
	if (limit <= 0 || chars.length === 0) {
		return [{ start: 0, end: text.length, startChar: 0, endChar: chars.length }];
	}

	const segments: Segment[] = [];
	let start = 0;
	let startChar = 0;
	let used = 0;
	let unit = 0;

	for (let index = 0; index < chars.length; index += 1) {
		const char = chars[index] ?? "";
		const charWidth = characterWidth(char);
		if (used + charWidth > limit && index > startChar) {
			segments.push({ start, end: unit, startChar, endChar: index });
			start = unit;
			startChar = index;
			used = 0;
		}
		used += charWidth;
		unit += char.length;
	}

	segments.push({ start, end: text.length, startChar, endChar: chars.length });
	return segments;
}

/** 光标偏移落在哪一段；正好在段边界上时归下一段，光标显示在下一行行首。 */
function segmentAt(segments: readonly Segment[], offset: number): number {
	let found = 0;
	for (let index = 0; index < segments.length; index += 1) {
		if ((segments[index] as Segment).start <= offset) found = index;
		else break;
	}
	return found;
}
