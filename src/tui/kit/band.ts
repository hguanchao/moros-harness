import { characterWidth, displayWidth, graphemes, truncateToWidth, wrapText, type Theme } from "#src/tui/term/index.ts";

/**
 * 横向色带里的正文排版。
 *
 * 色带是「从第 `start` 列起铺到右边界」的一段背景区域，比整行窄：工具详情、diff 与文件
 * 预览都长这个样子——左侧让出缩进，右侧留一列避开滚动条。这里只做排版，不认内容语义：
 * 行号与标记是调用方给的刻度，正文是若干带色片段，折行时按列宽切断、续行缩进到刻度之后。
 *
 * 之所以不是组件：色带依赖「起始列」这种横向偏移，而布局引擎按矩形分配，表达不了半个
 * 元素宽的起点。排版函数拿得到最终宽度，组件拿不到。
 */

/** 一段带颜色的文本；着色只到这一段为止，接下去要回到调用方给的颜色。 */
export interface ColoredSegment {
	readonly text: string;
	readonly color: string;
}

/** 色带的横向几何。 */
export interface BandGeometry {
	/** 整行宽度 */
	readonly width: number;
	/** 色带起始列 */
	readonly start: number;
	/** 右侧留白列数 */
	readonly rightPadding: number;
	/** 前缀最多能把正文挤到只剩几列 */
	readonly minContent: number;
}

/** 面板上下内边距：整条色带，不写内容。 */
export function bandBlankLine(width: number, start: number, theme: Theme): string {
	const left = Math.max(0, Math.min(start, width));
	const lead = " ".repeat(left);
	return `${lead}${theme.detailBg}${" ".repeat(Math.max(0, width - left))}${theme.reset}`;
}

/**
 * 无色标的正文行：折行后铺满色带。
 *
 * 带内留白由这里固定给出一列，不能从前缀里推导：色带起点一变，前缀就会被切光。但窄终端
 * 上留白不能把正文挤没，宽度不够时让出来。
 */
export function bandedLines(
	text: string,
	geometry: BandGeometry,
	color: string,
	background: string,
	theme: Theme,
): readonly string[] {
	const { width, start, rightPadding, minContent } = geometry;
	const left = Math.max(0, Math.min(start, width));
	const contentEnd = Math.max(left, width - rightPadding);
	const lead = " ".repeat(left);
	const innerWidth = Math.max(0, contentEnd - left);
	const insideWidth = innerWidth > minContent ? 1 : 0;
	const inside = " ".repeat(insideWidth);
	const lines = wrapText(text, Math.max(0, innerWidth - insideWidth));

	return lines.map((line) => {
		const content = `${inside}${line}`;
		const visible = truncateToWidth(content, innerWidth);
		// 空行与 hunk 之间的省略行不写内容，只留底色；给它们上文字色会在整行铺出一片色块
		const paint = visible.trim().length === 0 ? "" : color;
		const padding = " ".repeat(Math.max(0, width - left - displayWidth(visible)));
		return `${lead}${background}${paint}${visible}${padding}${theme.reset}`;
	});
}

/** 悬挂行：行号与标记只在首行，续行缩进到正文列。 */
export interface HangingOptions {
	/** 整行底色 */
	readonly background: string;
	/** 行号颜色 */
	readonly gutterColor: string;
	/** 标记颜色 */
	readonly markerColor: string;
}

/**
 * 带行号与标记的行换行时，续行缩进到行号之后的内容列。
 *
 * 行号与标记属于刻度而不是内容，压暗后正文才成为视觉主体。终端过窄时前缀会宽过整条
 * 色带：此时按「留白 → 行号 → 标记」依次让步，至少给正文留 `minContent` 列，否则整行
 * 会被推出终端宽度，或者正文整段消失。
 */
export function hangingLines(
	gutter: string,
	marker: string,
	segments: readonly ColoredSegment[],
	geometry: BandGeometry,
	options: HangingOptions,
	theme: Theme,
): readonly string[] {
	const { width, start, rightPadding, minContent } = geometry;
	const left = Math.max(0, Math.min(start, width));
	const contentEnd = Math.max(left, width - rightPadding);
	const lead = " ".repeat(left);
	const innerWidth = Math.max(0, contentEnd - left);

	const minBody = Math.min(minContent, innerWidth);
	let head = "";
	let headWidth = 0;
	const append = (text: string, color: string | undefined): void => {
		if (text.length === 0) return;
		const room = innerWidth - minBody - headWidth;
		if (room <= 0) return;
		const visible = truncateToWidth(text, room);
		if (visible.length === 0) return;
		head += color === undefined ? visible : `${color}${visible}`;
		headWidth += displayWidth(visible);
	};
	append(" ", undefined);
	append(gutter, options.gutterColor);
	append(marker, options.markerColor);

	const available = Math.max(1, innerWidth - headWidth);
	const wrapped = wrapSegments(segments, available);
	const continuation = " ".repeat(headWidth);

	return wrapped.map((line, index) => {
		const body = paintSegments(index === 0 ? head : continuation, headWidth, line, innerWidth);
		// 底色要铺满整行：行尾补齐用背景色而不是文字色，否则尾部会拖一条彩色的空白
		const padding = " ".repeat(Math.max(0, width - left - body.width));
		return `${lead}${options.background}${body.text}${padding}${theme.reset}`;
	});
}

/**
 * 按显示宽度折行，保留每段的颜色。
 *
 * 着色后的代码由多段不同颜色拼成，先摊成字符再按宽度切断，切点落在段中间时要把这段拆开，
 * 否则整段会因为放不下而被整体推到下一行，行宽就白算了。
 */
export function wrapSegments(
	segments: readonly ColoredSegment[],
	limit: number,
): readonly (readonly ColoredSegment[])[] {
	if (limit <= 0) return [[]];

	const lines: ColoredSegment[][] = [[]];
	let used = 0;

	for (const segment of segments) {
		for (const char of graphemes(segment.text)) {
			const charWidth = characterWidth(char);
			if (used + charWidth > limit && used > 0) {
				lines.push([]);
				used = 0;
			}
			appendColored(lines[lines.length - 1] ?? [], char, segment.color);
			used += charWidth;
		}
	}
	return lines;
}

/** 相邻同色字符合并，避免输出里出现大量只有一两个字符的转义序列。 */
function appendColored(line: ColoredSegment[], text: string, color: string): void {
	const last = line.at(-1);
	if (last !== undefined && last.color === color) {
		line[line.length - 1] = { text: last.text + text, color };
		return;
	}
	line.push({ text, color });
}

/**
 * 把前缀与彩色正文拼成一行，并按宽度截断。
 *
 * 截断必须按字符进行：着色后每段都带转义序列，按字符串长度一刀切会把转义序列截成半截，
 * 终端上就会出现整屏乱码。正文结束后回到背景色，行尾填充才不会拖着文字色。
 */
export function paintSegments(
	prefix: string,
	prefixWidth: number,
	segments: readonly ColoredSegment[],
	limit: number,
): { readonly text: string; readonly width: number } {
	let remaining = Math.max(0, limit - prefixWidth);
	let output = prefix;
	let width = prefixWidth;

	for (const segment of segments) {
		if (remaining <= 0) break;
		const visible = truncateToWidth(segment.text, remaining);
		if (visible.length === 0) continue;
		output += `${segment.color}${visible}`;
		width += displayWidth(visible);
		remaining -= displayWidth(visible);
	}
	return { text: output, width };
}
