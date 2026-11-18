import type { Theme } from "../../term/index.ts";
import { bandedLines, hangingLines, type BandGeometry, type ColoredSegment } from "../band.ts";
import { highlightCode, type SyntaxSegment } from "./syntax.ts";
import { syntaxColor } from "./syntax-style.ts";

/**
 * diff 预览的排版。
 *
 * 输入是**已算好的 diff 文本**：每行形如 `12 + added`、`12 - removed`、`12   context`，
 * 行号宽度由上游决定。这里不做比对——比对属于业务，排版属于库。认不出的行按普通正文折行。
 *
 * 增删由整行底色表示，代码本身按语法着色；行号跟着增删走，一眼能分出这一行的归属，不必
 * 来回对标记列。
 */

/** 带行号的一行：`12 + text` / `12 - text` / `12   text`。 */
const ROW = /^(\s*\d+ )([-+] |  )(.*)$/;

/** 只有增删行才改变行号颜色，上下文行沿用正文色。 */
const MARKED_ROW = /^\s*\d+ ([-+]) /;

export interface DiffOptions {
	/** 已切好行的 diff 文本，含行号 */
	readonly rows: readonly string[];
	/** 文件名：语言只按扩展名判断 */
	readonly fileName: string;
	readonly geometry: BandGeometry;
	readonly theme: Theme;
}

/** 一段 diff 的全部屏幕行。 */
export function diffLines(options: DiffOptions): readonly string[] {
	const { rows, fileName, geometry, theme } = options;
	const syntax = diffSyntax(rows, fileName);
	return rows.flatMap((row, index) => rowLines(row, syntax?.[index], geometry, theme));
}

function rowLines(
	row: string,
	syntax: readonly SyntaxSegment[] | undefined,
	geometry: BandGeometry,
	theme: Theme,
): readonly string[] {
	const color = rowColor(row, theme);
	const match = ROW.exec(row);
	if (match === null) {
		return bandedLines(row, geometry, color, theme.detailBg, theme);
	}

	const gutter = match[1] ?? "";
	const marker = match[2] ?? "  ";
	const background = marker === "+ " ? theme.diffInsertBg : marker === "- " ? theme.diffDeleteBg : theme.detailBg;
	const markerColor = marker === "+ " ? theme.success : marker === "- " ? theme.error : color;
	// 认不出语言时整行退回正文色；能着色时没有角色的标点仍取正文色
	const segments: readonly ColoredSegment[] =
		syntax === undefined
			? [{ text: match[3] ?? "", color }]
			: syntax.map((segment) => ({ text: segment.text, color: syntaxColor(segment.token, theme) }));

	return hangingLines(gutter, marker, segments, geometry, { background, gutterColor: markerColor, markerColor }, theme);
}

/** 未匹配行号格式时的正文色：省略行最弱，裸增删仍按增删着色。 */
function rowColor(row: string, theme: Theme): string {
	const marked = MARKED_ROW.exec(row);
	if (marked !== null) return marked[1] === "+" ? theme.success : theme.error;
	// 两个 hunk 之间的省略行不是正文，弱化到背景里
	if (row.trimStart().startsWith("…")) return theme.textSubtle;
	if (row.startsWith("+")) return theme.success;
	if (row.startsWith("-")) return theme.error;
	return theme.textSecondary;
}

/**
 * diff 里的代码着色。
 *
 * 一份 diff 交错着两个版本：删行属于旧文件、增行属于新文件。块注释、模板字符串这类跨行结构
 * 必须各自在自己的版本里解析，否则颜色会在增删交界处串味，因此新旧两侧各解析一次再按行映射
 * 回来。认不出语言时返回 undefined，调用方按纯文本渲染。
 */
function diffSyntax(
	rows: readonly string[],
	fileName: string,
): readonly (readonly SyntaxSegment[] | undefined)[] | undefined {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	const slots: ({ readonly side: "old" | "new"; readonly index: number } | undefined)[] = [];

	for (const row of rows) {
		const match = ROW.exec(row);
		if (match === null) {
			slots.push(undefined);
			continue;
		}
		const marker = match[2] ?? "  ";
		const text = match[3] ?? "";
		if (marker === "- ") {
			slots.push({ side: "old", index: oldLines.length });
			oldLines.push(text);
			continue;
		}
		// 新增行与上下文行都属于新版本；上下文行同时补进旧版本，两侧才能保持完整
		slots.push({ side: "new", index: newLines.length });
		newLines.push(text);
		if (marker === "  ") oldLines.push(text);
	}

	const oldParsed = oldLines.length === 0 ? undefined : highlightCode(oldLines.join("\n"), fileName);
	const newParsed = newLines.length === 0 ? undefined : highlightCode(newLines.join("\n"), fileName);
	if (oldParsed === undefined && newParsed === undefined) return undefined;

	return slots.map((slot) => {
		if (slot === undefined) return undefined;
		return (slot.side === "old" ? oldParsed : newParsed)?.[slot.index];
	});
}
