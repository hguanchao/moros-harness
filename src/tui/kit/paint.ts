import { displayWidth, type Theme } from "#src/tui/term/index.ts";
import { clip, fit, fitLine } from "#src/tui/kit/fit.ts";
import { inputLines } from "#src/tui/kit/input.ts";
import {
	type BoxLayout,
	type DividerLayout,
	type LayoutNode,
	type RawLayout,
	type ScrollLayout,
	type TextLayout,
} from "#src/tui/kit/layout.ts";
import { listLines } from "#src/tui/kit/list.ts";
import { pageLines } from "#src/tui/kit/page.ts";
import { statusBarLine } from "#src/tui/kit/statusbar.ts";

/**
 * 绘制。
 *
 * 每个节点画成「高度正好等于自己矩形、每行宽度正好等于自己矩形」的字符串数组，父容器
 * 因此可以直接按行拼接——不需要坐标写入，也不会出现互相覆盖。这是整帧写入（`Screen`）
 * 之前的最后一步：绘制产出纯行，写入按坐标落屏。
 */

/** 边框字符。只做单线框：终端里双线框与粗线框的实际观感依赖字体，收益不值这份复杂度。 */
const BORDER = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
} as const;

/** 画一棵子树。 */
export function paint(node: LayoutNode, theme: Theme): readonly string[] {
	switch (node.kind) {
		case "empty":
			return blanks(node.rect.height, node.rect.width);
		case "text":
			return paintText(node, theme);
		case "raw":
			return paintRaw(node);
		case "divider":
			return paintDivider(node, theme);
		case "scroll":
			return paintScroll(node);
		case "list":
			return fit(listLines(node, node.rect.width, theme), node.rect.width, node.rect.height);
		case "input":
			return fit(inputLines(node, node.rect.width, theme), node.rect.width, node.rect.height);
		case "page":
			return fit(pageLines(node.props, node.rect.width, node.rect.height, theme), node.rect.width, node.rect.height);
		case "statusbar":
			return fit([statusBarLine(node.props, node.rect.width, theme)], node.rect.width, node.rect.height);
		case "box":
			return paintBox(node, theme);
	}
}

function paintText(node: TextLayout, theme: Theme): readonly string[] {
	const width = Math.max(0, node.rect.width);
	const rows: string[] = [];
	for (let row = 0; row < node.rect.height; row += 1) {
		const line = node.lines[row] ?? "";
		const visible = Math.min(width, displayWidth(line));
		const left =
			node.align === "right" ? width - visible : node.align === "center" ? Math.floor((width - visible) / 2) : 0;
		const right = Math.max(0, width - visible - left);
		// 复位放在补白之前：底色与前景色不会因为补白而延续到行尾
		const body = node.color === undefined ? line : `${node.color}${line}${theme.reset}`;
		rows.push(`${" ".repeat(left)}${body}${" ".repeat(right)}`);
	}
	return rows;
}

function paintRaw(node: RawLayout): readonly string[] {
	const width = Math.max(0, node.rect.width);
	const rows = node.lines.map((line) => clip(line, width));
	while (rows.length < node.rect.height) rows.push(" ".repeat(width));
	return rows.slice(0, node.rect.height);
}

/** 滚动视口：只露出 `scrollTop` 之后的一段，按视口高度截断并补白。 */
function paintScroll(node: ScrollLayout): readonly string[] {
	const width = Math.max(0, node.rect.width);
	const start = Math.min(Math.max(0, node.scrollTop), Math.max(0, node.lines.length));
	const rows = node.lines.slice(start, start + node.rect.height).map((line) => clip(line, width));
	while (rows.length < node.rect.height) rows.push(" ".repeat(width));
	return rows;
}

function paintDivider(node: DividerLayout, theme: Theme): readonly string[] {
	const width = Math.max(0, node.rect.width);
	const char = node.char.length === 0 ? "─" : node.char;
	const line = char.repeat(width);
	const body = node.color === undefined ? line : `${node.color}${line}${theme.reset}`;
	const rows = [body];
	while (rows.length < node.rect.height) rows.push(" ".repeat(width));
	return rows.slice(0, node.rect.height);
}

function paintBox(node: BoxLayout, theme: Theme): readonly string[] {
	const { padding, border, margin } = node;
	const edge = margin + (border ? 1 : 0);
	const contentWidth = Math.max(0, node.rect.width - 2 * edge - 2 * padding.x);
	const contentHeight = Math.max(0, node.rect.height - 2 * edge - 2 * padding.y);
	const content = {
		x: node.rect.x + edge + padding.x,
		y: node.rect.y + edge + padding.y,
		width: contentWidth,
		height: contentHeight,
	};

	let lines = composeChildren(node, theme, content);
	// 水平 padding
	lines = lines.map((line) => `${" ".repeat(padding.x)}${line}${" ".repeat(padding.x)}`);
	let width = contentWidth + 2 * padding.x;
	// 垂直 padding
	lines = [...blanks(padding.y, width), ...lines, ...blanks(padding.y, width)];

	if (border) {
		lines = [
			`${theme.border}${BORDER.topLeft}${BORDER.horizontal.repeat(width)}${BORDER.topRight}${theme.reset}`,
			...lines.map(
				(line) =>
					`${theme.border}${BORDER.vertical}${theme.reset}${line}${theme.border}${BORDER.vertical}${theme.reset}`,
			),
			`${theme.border}${BORDER.bottomLeft}${BORDER.horizontal.repeat(width)}${BORDER.bottomRight}${theme.reset}`,
		];
		width += 2;
	}

	if (margin > 0) {
		lines = lines.map((line) => `${" ".repeat(margin)}${line}${" ".repeat(margin)}`);
		width += 2 * margin;
		lines = [...blanks(margin, width), ...lines, ...blanks(margin, width)];
	}

	return fit(lines, node.rect.width, node.rect.height);
}

/**
 * 按坐标把子节点铺进内容区。
 *
 * 不按「顺序拼接」而是按矩形落位：`gap`、`margin` 与伸缩留下来的空档都在坐标里，顺序
 * 拼接会把它们吃掉。横向空档补空格、纵向空档保留空行，两者都靠坐标推出来。
 */
function composeChildren(
	node: BoxLayout,
	theme: Theme,
	content: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): string[] {
	const painted = node.children
		.map((child) => ({ rect: child.rect, lines: paint(child, theme) }))
		.sort((left, right) => left.rect.x - right.rect.x || left.rect.y - right.rect.y);
	const rows: string[] = [];

	for (let row = 0; row < content.height; row += 1) {
		const absoluteY = content.y + row;
		let line = "";
		let cursor = content.x;
		for (const item of painted) {
			const local = absoluteY - item.rect.y;
			if (local < 0 || local >= item.rect.height) continue;
			if (item.rect.x > cursor) line += " ".repeat(item.rect.x - cursor);
			line += item.lines[local] ?? " ".repeat(item.rect.width);
			cursor = Math.max(cursor, item.rect.x + item.rect.width);
		}
		rows.push(fitLine(line, content.width));
	}
	return rows;
}

/** 若干空白行。 */
function blanks(count: number, width: number): string[] {
	return Array.from({ length: Math.max(0, count) }, () => " ".repeat(Math.max(0, width)));
}
