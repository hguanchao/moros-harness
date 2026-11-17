import type { Theme } from "#src/tui/term/index.ts";

/**
 * 元素树。
 *
 * 只有三件事：`type + props + children`、函数式组件、以及把「组件」归一成少数内建原语。
 * 没有 hooks、没有状态、没有 diff 循环——组件是无状态纯函数，布局与绘制由引擎按原语完成。
 */

/** 组件能拿到的运行期上下文：主题由调用方注入，库内不预设配色。 */
export interface ComponentProps {
	readonly theme: Theme;
}

/** 子节点：字符串就是一段文字。 */
export type Node = string | ElementNode;

/** `el()` 接受的子节点：允许数组、空值与布尔假值，方便条件渲染。 */
export type Child = Node | readonly Child[] | null | undefined | false;

/**
 * 内建原语。
 *
 * 前五个是通用盒子；后三个是「需要知道自己最终矩形才能排版」的叶子——折行、滚动窗口与
 * 光标列都依赖解析后的宽度，因此不能由函数式组件预先算好。
 */
export type IntrinsicName =
	"box" | "text" | "divider" | "raw" | "spacer" | "scroll" | "list" | "input" | "page" | "statusbar";

/** 全部内建原语，顺序无关。 */
export const INTRINSICS: readonly IntrinsicName[] = [
	"box",
	"text",
	"divider",
	"raw",
	"spacer",
	"scroll",
	"list",
	"input",
	"page",
	"statusbar",
];

/**
 * 函数式组件。
 *
 * 返回节点而不是渲染好的行：只有返回节点，布局引擎才能测量与定位。叶子节点若已有成品行，
 * 用 `raw` 原语交回去。
 */
export interface Component<P extends object = Record<string, never>> {
	(props: P & ComponentProps & { readonly children: readonly Node[] }): Node;
}

/** 元素类型：内建原语名，或一个函数式组件。 */
export type ElementType = IntrinsicName | Component<never>;

/** 一个元素节点。 */
export interface ElementNode {
	readonly type: ElementType;
	readonly props: Readonly<Record<string, unknown>>;
	readonly children: readonly Node[];
}

/**
 * 创建一个元素。
 *
 * 数组子节点会被摊平一层，`null` / `undefined` / `false` 直接丢弃——条件渲染不必先过滤。
 *
 * @param type 内建原语名或函数式组件
 * @param props 该元素的属性；可为 `null` 表示无属性
 * @param children 子节点
 * @returns 元素节点
 */
export function el(type: ElementType, props: object | null, ...children: readonly Child[]): ElementNode {
	// 属性一律以只读字典保存：组件自己声明更精确的 props 类型，引擎只需要按名字取值。
	// 这里的一次断言换来「调用方可以传任意对象类型」——interface 没有隐式索引签名，
	// 不收窄的话每个 props 接口都得为了传进 el() 改成 type 别名。
	return { type, props: (props ?? {}) as Readonly<Record<string, unknown>>, children: flatten(children) };
}

/** 摊平子节点并丢弃空值。 */
function flatten(children: readonly Child[]): readonly Node[] {
	const out: Node[] = [];
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		if (Array.isArray(child)) {
			out.push(...flatten(child as readonly Child[]));
			continue;
		}
		out.push(child as Node);
	}
	return out;
}

/** 判断一个节点是不是元素（字符串是文本子节点）。 */
export function isElement(node: Node): node is ElementNode {
	return typeof node === "object" && node !== null;
}
