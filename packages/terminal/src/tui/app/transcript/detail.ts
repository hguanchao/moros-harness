import { stripVTControlCharacters } from "node:util";

import type { ResultDetailKind } from "../contract/result-detail.ts";
import { hiddenLines } from "../copy/index.ts";
import {
	bandBlankLine as kitBandBlankLine,
	bandedLines as kitBandedLines,
	hangingLines,
	type BandGeometry,
	type ColoredSegment,
} from "../../kit/index.ts";
import { diffLines, highlightCode, syntaxColor, type SyntaxSegment } from "../../kit/markdown/entry.ts";
import { characterWidth, displayWidth, graphemes } from "../../term/index.ts";
import { THEME } from "../render/theme.ts";
import {
	DETAIL_BAND_MAX_LINES,
	DETAIL_BAND_LEFT,
	DETAIL_RIGHT_PADDING,
	MIN_DETAIL_CONTENT,
	TAB_STOP,
} from "./style.ts";
import type { TranscriptTool } from "./types.ts";

/**
 * 工具详情色带。
 *
 * 排版原语（色带、悬挂行、按段折行）在 `src/tui/kit`，diff 的解析与着色在
 * `src/tui/kit/markdown`。这里只剩下业务装配：取哪几行、被裁掉多少行怎么提示、
 * 文件预览怎么剥行号。
 */

/** 展开的详情色带：上下各留一行，右侧铺到面板边缘。失败行展开时也复用它。 */
export function detailBand(tool: TranscriptTool, baseIndent: string, width: number): readonly string[] {
	const bandStart = displayWidth(baseIndent) + DETAIL_BAND_LEFT;
	const kind = tool.detailKind ?? "text";
	// 工具结果普遍以换行结尾，直接切行会在详情末尾多出一个空行，与下边距叠成两行留白
	const rows = stripTrailingBlank((tool.fullDetail ?? "").split("\n"));
	// 先剥 ANSI 再展开制表符，最后清剩余控制字符：顺序反了会让制表位按不可见的
	// 转义序列宽度计算，缩进对不齐；文件内容里的颜色序列也会以 `[31m` 残渣上屏。
	const visible = rows
		.slice(0, DETAIL_BAND_MAX_LINES)
		.map((row) => stripLineControls(expandTabs(stripVTControlCharacters(row))));
	const geometry = bandGeometry(width, bandStart);
	const syntax = kind === "file" ? fileSyntax(visible, tool.detail) : undefined;
	const body =
		kind === "diff"
			? diffLines({ rows: visible, fileName: tool.detail, geometry, theme: THEME })
			: visible.flatMap((line, index) => detailBodyLines(line, kind, geometry, detailColor(kind), syntax?.[index]));
	const hidden = rows.length - visible.length;
	return [
		bandBlankLine(width, bandStart),
		...body,
		...(hidden === 0
			? []
			: bandedWrappedLines(hiddenLines(hidden, "Ctrl+G"), width, THEME.textSubtle, bandStart, DETAIL_RIGHT_PADDING)),
		bandBlankLine(width, bandStart),
	];
}

/** 色带几何：起点、右留白与「前缀最多挤到剩几列」三件事定死一处。 */
function bandGeometry(width: number, bandStart: number): BandGeometry {
	return {
		width,
		start: bandStart,
		rightPadding: DETAIL_RIGHT_PADDING,
		minContent: MIN_DETAIL_CONTENT,
	};
}

/**
 * 去掉末尾的空行。
 *
 * 工具结果常以换行结尾，切行后最后一项是空串；渲染时它会占掉一整行，与面板本来的下边距
 * 叠在一起，看起来就像底部莫名多了两行留白。
 */
export function stripTrailingBlank(rows: readonly string[]): readonly string[] {
	let end = rows.length;
	while (end > 0 && (rows[end - 1] ?? "").trim().length === 0) end -= 1;
	return end === rows.length ? rows : rows.slice(0, end);
}

/** 按固定制表位展开制表符；换行由调用方先切好，这里只处理行内。 */
export function expandTabs(text: string): string {
	let column = 0;
	let output = "";
	for (const char of graphemes(text)) {
		if (char === "\t") {
			const width = TAB_STOP - (column % TAB_STOP);
			output += " ".repeat(width);
			column += width;
			continue;
		}
		output += char;
		column += characterWidth(char);
	}
	return output;
}

/**
 * 去掉行内的控制字符。
 *
 * 详情正文来自工具结果与错误信息，其中可能夹着 CR：终端把 CR 当回车执行，它之后的补齐
 * 空格会从行首重写，把整条色带盖回终端底色。宽度计算同样会因此偏一位，正文被截短。
 * 行已经切好，这里的换行符不参与排版，一并清掉。
 */
export function stripLineControls(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * 详情行：文件预览带行号，续行按行号后的内容列悬挂缩进；其余按正文折行。
 */
function detailBodyLines(
	line: string,
	kind: ResultDetailKind,
	geometry: BandGeometry,
	color: string,
	syntax: readonly SyntaxSegment[] | undefined,
): readonly string[] {
	if (kind === "file") {
		const match = /^(\s*\d+\s+)(.*)$/.exec(line);
		if (match !== null) {
			const segments: readonly ColoredSegment[] =
				syntax === undefined
					? [{ text: match[2] ?? "", color }]
					: syntax.map((segment) => ({
							text: segment.text,
							// 没有角色的标点保持正文色，别把整行提亮成白色
							color: segment.token === undefined ? color : syntaxColor(segment.token, THEME),
						}));
			return hangingLines(
				match[1] ?? "",
				"",
				segments,
				geometry,
				{ background: THEME.detailBg, gutterColor: THEME.textSubtle, markerColor: color },
				THEME,
			);
		}
	}
	return bandedWrappedLines(line, geometry.width, color, geometry.start, geometry.rightPadding);
}

/**
 * 文件内容的语法着色。
 *
 * 带行号的正文按行号后的内容列重建整段代码再解析，行号与省略行不进入源码：跨行结构
 * 只有整段解析才能判对。行号列宽度由 read 工具补宽，这里按「数字 + 任意空白」剥离。
 */
function fileSyntax(
	rows: readonly string[],
	fileName: string,
): readonly (readonly SyntaxSegment[] | undefined)[] | undefined {
	const code: string[] = [];
	const slots: (number | undefined)[] = [];
	for (const row of rows) {
		const match = /^\s*\d+\s+(.*)$/.exec(row);
		if (match === null) {
			slots.push(undefined);
			continue;
		}
		slots.push(code.length);
		code.push(match[1] ?? "");
	}
	if (code.length === 0) return undefined;

	const parsed = highlightCode(code.join("\n"), fileName);
	if (parsed === undefined) return undefined;
	return slots.map((slot) => (slot === undefined ? undefined : parsed[slot]));
}

/** 面板上下内边距：整条色带，不写内容。 */
export function bandBlankLine(width: number, bandStart: number): string {
	return kitBandBlankLine(width, bandStart, THEME);
}

/** 详情行换行后同样从 bandStart 列开始铺色带，带内留一列内边距。 */
export function bandedWrappedLines(
	text: string,
	width: number,
	color: string,
	bandStart: number,
	rightPadding: number,
): readonly string[] {
	return kitBandedLines(
		text,
		{ width, start: bandStart, rightPadding, minContent: MIN_DETAIL_CONTENT },
		color,
		THEME.detailBg,
		THEME,
	);
}

/** 详情行的颜色：diff 的增删已由 kit 决定，这里只剩文件与正文。 */
function detailColor(kind: ResultDetailKind): string {
	if (kind === "file") return THEME.textSecondary;
	return THEME.textPrimary;
}
