import { stripVTControlCharacters } from "node:util";

import { displayWidth, wrapText } from "#src/tui/term/index.ts";
import { inputHeight } from "#src/tui/kit/input.ts";
import { listHeight, listItemsOf, type ListItem } from "#src/tui/kit/list.ts";
import { pageHeight, pagePropsOf, type PageProps } from "#src/tui/kit/page.ts";
import { statusBarPropsOf, type StatusBarProps } from "#src/tui/kit/statusbar.ts";
import { booleanProp, numberProp, paddingOf, stringProp, type IntrinsicNode } from "#src/tui/kit/normalize.ts";

/**
 * 布局引擎（子集）。
 *
 * 只做界面真正用得到的部分：row/column、固定宽高、flexGrow、padding/margin、border、
 * 文本折行与裁剪。不做绝对定位与百分比——那类能力一旦引入，测量与命中测试都要跟着
 * 变复杂，而终端界面里没有对应的需求。
 *
 * 两遍遍历：`measure` 先算出每个节点的自然尺寸，`layout` 再按可用空间定位。结果是一棵
 * 带矩形的树，绘制与命中测试共用它。
 */

/** 终端坐标：x/y 从 0 起，width/height 以列为单位。 */
export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** 一个盒子的自然尺寸。 */
export interface Size {
	readonly width: number;
	readonly height: number;
}

/** 水平对齐；只用于文本。 */
export type TextAlign = "left" | "center" | "right";

interface BoxBase {
	readonly rect: Rect;
}

/** 容器盒子。 */
export interface BoxLayout extends BoxBase {
	readonly kind: "box";
	readonly direction: "row" | "column";
	readonly gap: number;
	readonly border: boolean;
	readonly padding: { readonly x: number; readonly y: number };
	readonly margin: number;
	readonly children: readonly LayoutNode[];
}

/** 文本叶子，`lines` 已按自身宽度折好。 */
export interface TextLayout extends BoxBase {
	readonly kind: "text";
	readonly lines: readonly string[];
	readonly color: string | undefined;
	readonly align: TextAlign;
}

/** 预先渲染好的行；宽度由调用方保证不超过分配宽度。 */
export interface RawLayout extends BoxBase {
	readonly kind: "raw";
	readonly lines: readonly string[];
}

/** 整行分隔线。 */
export interface DividerLayout extends BoxBase {
	readonly kind: "divider";
	readonly char: string;
	readonly color: string | undefined;
}

/** 占位（flexGrow 填充、或被折叠掉的空间）。 */
export interface EmptyLayout extends BoxBase {
	readonly kind: "empty";
}

/** 滚动视口：内容已由调用方渲染成行，这里只决定露出哪一段。 */
export interface ScrollLayout extends BoxBase {
	readonly kind: "scroll";
	readonly lines: readonly string[];
	readonly scrollTop: number;
}

/** 列表面板。 */
export interface ListLayout extends BoxBase {
	readonly kind: "list";
	readonly items: readonly ListItem[];
	readonly cursor: number;
	readonly scrollTop: number | undefined;
	readonly visible: number | undefined;
	readonly empty: string | undefined;
	readonly countLabel: string | undefined;
}

/** 输入框。 */
export interface InputLayout extends BoxBase {
	readonly kind: "input";
	readonly value: string;
	readonly cursor: number;
	readonly focused: boolean;
	readonly commandLength: number | undefined;
	readonly maxLines: number | undefined;
}

/** 整屏页。 */
export interface PageLayout extends BoxBase {
	readonly kind: "page";
	readonly props: PageProps;
}

/** 状态行；一行高，宽度由容器给。 */
export interface StatusBarLayout extends BoxBase {
	readonly kind: "statusbar";
	readonly props: StatusBarProps;
}

/** 布局结果节点。 */
export type LayoutNode =
	| BoxLayout
	| TextLayout
	| RawLayout
	| DividerLayout
	| EmptyLayout
	| ScrollLayout
	| ListLayout
	| InputLayout
	| PageLayout
	| StatusBarLayout;

/** 无穷大宽度：调用方没给上限时按内容排。 */
const UNBOUNDED = 100_000;

/**
 * 从外框到内容区的内缩量。
 *
 * 三者叠在一起算：margin 在外、border 居中、padding 贴内容；调用方只需要一个偏移量。
 */
function insets(node: IntrinsicNode): { readonly x: number; readonly y: number; readonly margin: number } {
	const padding = paddingOf(node.props);
	const border = booleanProp(node.props, "border") ? 1 : 0;
	const margin = Math.max(0, numberProp(node.props, "margin"));
	return { x: padding.x + border + margin, y: padding.y + border + margin, margin };
}

/** 显式宽高；没有时返回 undefined。 */
function explicit(props: Readonly<Record<string, unknown>>, key: "width" | "height"): number | undefined {
	return optionalNumber(props, key);
}

/** 可选的非负整数属性；缺失或类型不对时返回 undefined。 */
function optionalNumber(props: Readonly<Record<string, unknown>>, key: string): number | undefined {
	const value = props[key];
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

/**
 * 测量节点的自然尺寸。
 *
 * @param node 归一化后的节点
 * @param maxWidth 可用宽度上限；不设上限时按内容宽度排
 */
export function measure(node: IntrinsicNode, maxWidth: number = UNBOUNDED): Size {
	const limit = Number.isFinite(maxWidth) ? Math.max(0, Math.floor(maxWidth)) : UNBOUNDED;
	switch (node.type) {
		case "text": {
			const lines = limit === 0 ? [""] : wrapText(textOf(node), limit);
			const widest = lines.reduce((max, line) => Math.max(max, displayWidth(line)), 0);
			return { width: Math.min(widest, limit), height: lines.length };
		}
		case "raw": {
			const lines = rawLinesOf(node);
			const widest = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
			return { width: Math.min(widest, limit), height: lines.length };
		}
		case "divider":
			return { width: limit, height: 1 };
		case "spacer":
			return { width: 0, height: 0 };
		case "scroll": {
			const lines = rawLinesOf(node);
			const widest = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
			return { width: Math.min(widest, limit), height: lines.length };
		}
		case "list": {
			const items = listItemsOf(node.props);
			return {
				width: limit,
				height: listHeight(
					items.length,
					optionalNumber(node.props, "visible"),
					stringProp(node.props, "empty") !== undefined,
				),
			};
		}
		case "input": {
			const value = stringProp(node.props, "value") ?? "";
			return { width: limit, height: inputHeight(value, limit, optionalNumber(node.props, "maxLines")) };
		}
		case "page":
			return { width: limit, height: pageHeight(pagePropsOf(node.props), limit) };
		case "statusbar":
			return { width: limit, height: 1 };
		case "box":
			return measureBox(node, limit);
	}
}

function measureBox(node: IntrinsicNode, maxWidth: number): Size {
	const { x, y, margin } = insets(node);
	const innerMax = Math.max(0, maxWidth - 2 * x);
	const gap = Math.max(0, numberProp(node.props, "gap"));
	const children = node.children.map((child) => measure(child, innerMax));
	const direction = directionOf(node);
	const innerWidth =
		direction === "row"
			? sum(children.map((size) => size.width)) + gap * Math.max(0, children.length - 1)
			: max(children.map((size) => size.width));
	const innerHeight =
		direction === "row"
			? max(children.map((size) => size.height))
			: sum(children.map((size) => size.height)) + gap * Math.max(0, children.length - 1);
	const width = explicit(node.props, "width") ?? innerWidth + 2 * x;
	const height = explicit(node.props, "height") ?? innerHeight + 2 * y;
	return {
		width: Math.min(maxWidth, width + 2 * margin),
		height: height + 2 * margin,
	};
}

/**
 * 在给定矩形内定位整棵子树。
 *
 * @param node 归一化后的节点
 * @param rect 该节点占用的外框（含 margin）
 */
export function layout(node: IntrinsicNode, rect: Rect): LayoutNode {
	switch (node.type) {
		case "text":
			return textAt(node, rect);
		case "raw":
			return { kind: "raw", rect, lines: rawLinesOf(node) };
		case "divider":
			return {
				kind: "divider",
				rect,
				char: stringProp(node.props, "char") ?? "─",
				color: stringProp(node.props, "color"),
			};
		case "spacer":
			return { kind: "empty", rect };
		case "scroll":
			return { kind: "scroll", rect, lines: rawLinesOf(node), scrollTop: numberProp(node.props, "scrollTop") };
		case "list":
			return {
				kind: "list",
				rect,
				items: listItemsOf(node.props),
				cursor: numberProp(node.props, "cursor"),
				scrollTop: optionalNumber(node.props, "scrollTop"),
				visible: optionalNumber(node.props, "visible"),
				empty: stringProp(node.props, "empty"),
				countLabel: stringProp(node.props, "countLabel"),
			};
		case "input":
			return {
				kind: "input",
				rect,
				value: stringProp(node.props, "value") ?? "",
				cursor: numberProp(node.props, "cursor"),
				focused: booleanProp(node.props, "focused"),
				commandLength: optionalNumber(node.props, "commandLength"),
				maxLines: optionalNumber(node.props, "maxLines"),
			};
		case "page":
			return { kind: "page", rect, props: pagePropsOf(node.props) };
		case "statusbar":
			return { kind: "statusbar", rect, props: statusBarPropsOf(node.props) };
		case "box":
			return boxAt(node, rect);
	}
}

function textAt(node: IntrinsicNode, rect: Rect): TextLayout {
	const width = Math.max(0, rect.width);
	const lines = width === 0 ? [""] : wrapText(textOf(node), width);
	return {
		kind: "text",
		rect,
		lines,
		color: stringProp(node.props, "color"),
		align: alignOf(node),
	};
}

function boxAt(node: IntrinsicNode, rect: Rect): BoxLayout {
	const { x: insetX, y: insetY, margin } = insets(node);
	const border = booleanProp(node.props, "border");
	const padding = paddingOf(node.props);
	const direction = directionOf(node);
	const gap = Math.max(0, numberProp(node.props, "gap"));
	// 内容区：外框去掉 margin、边框与 padding
	const content: Rect = {
		x: rect.x + insetX,
		y: rect.y + insetY,
		width: Math.max(0, rect.width - 2 * insetX),
		height: Math.max(0, rect.height - 2 * insetY),
	};
	const children = node.children;
	const natural = children.map((child) => measure(child, content.width));
	const mainAxis = direction === "row" ? "width" : "height";
	const available = mainAxis === "width" ? content.width : content.height;
	const gaps = gap * Math.max(0, children.length - 1);
	const used = sum(natural.map((size) => size[mainAxis])) + gaps;
	const free = Math.max(0, available - used);
	const flexTotal = sum(children.map((child) => flexOf(child)));
	const sizes = natural.map((size) => size[mainAxis]);
	if (free > 0 && flexTotal > 0) {
		let assigned = 0;
		children.forEach((child, index) => {
			const flex = flexOf(child);
			if (flex === 0) return;
			const extra = Math.floor((free * flex) / flexTotal);
			sizes[index] = (sizes[index] ?? 0) + extra;
			assigned += extra;
		});
		// 取整剩下的列给最后一个可伸缩的子节点，避免右侧空出一条缝
		const remainder = free - assigned;
		if (remainder > 0) {
			for (let index = children.length - 1; index >= 0; index -= 1) {
				const child = children[index];
				if (child !== undefined && flexOf(child) > 0) {
					sizes[index] = (sizes[index] ?? 0) + remainder;
					break;
				}
			}
		}
	}

	const placed: LayoutNode[] = [];
	let cursor = direction === "row" ? content.x : content.y;
	children.forEach((child, index) => {
		const size = sizes[index] ?? 0;
		const childRect: Rect =
			direction === "row"
				? { x: cursor, y: content.y, width: size, height: content.height }
				: { x: content.x, y: cursor, width: content.width, height: size };
		placed.push(layout(child, childRect));
		cursor += size + gap;
	});

	return { kind: "box", rect, direction, gap, border, padding, margin, children: placed };
}

/** text 原语的内容：`text` 属性优先，其次拼接字符串子节点。 */
function textOf(node: IntrinsicNode): string {
	const direct = stringProp(node.props, "text");
	if (direct !== undefined) return direct;
	return node.children.map((child) => stringProp(child.props, "text") ?? "").join("");
}

/** raw 原语的行；非字符串项被丢弃。 */
function rawLinesOf(node: IntrinsicNode): readonly string[] {
	const value = node.props["lines"];
	if (!Array.isArray(value)) return [];
	return value.filter((line): line is string => typeof line === "string");
}

function directionOf(node: IntrinsicNode): "row" | "column" {
	return node.props["direction"] === "row" ? "row" : "column";
}

function alignOf(node: IntrinsicNode): TextAlign {
	const value = node.props["align"];
	return value === "center" || value === "right" ? value : "left";
}

/** 子节点的伸缩权重；spacer 默认吃满剩余空间。 */
function flexOf(node: IntrinsicNode): number {
	const value = numberProp(node.props, "flexGrow", node.type === "spacer" ? 1 : 0);
	return Math.max(0, value);
}

/** 一行文本的可见宽度：先剥掉转义序列再数字符列。 */
export function visibleWidth(line: string): number {
	return displayWidth(stripVTControlCharacters(line));
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function max(values: readonly number[]): number {
	return values.reduce((widest, value) => Math.max(widest, value), 0);
}
