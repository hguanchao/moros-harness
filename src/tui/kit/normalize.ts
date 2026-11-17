import type { Theme } from "#src/tui/term/index.ts";
import { INTRINSICS, isElement, type ElementNode, type IntrinsicName, type Node } from "#src/tui/kit/element.ts";

/**
 * 归一化。
 *
 * 把「任意节点」压成只剩内建原语的树：函数式组件在这里被调用一次，字符串变成 text 原语。
 * 布局与绘制因此只面对五种原语，不必关心组件是怎么写的。
 */

/** 归一化后的节点：只可能是内建原语。 */
export interface IntrinsicNode {
	readonly type: IntrinsicName;
	readonly props: Readonly<Record<string, unknown>>;
	readonly children: readonly IntrinsicNode[];
}

/** 组件递归深度上限：组件里套组件是正常的，自己调自己不是。 */
const MAX_DEPTH = 64;

/**
 * 展开函数式组件，得到纯原语树。
 *
 * @param node 任意节点
 * @param theme 注入给组件的主题
 * @throws 内建原语名非法、组件递归过深、text 原语下出现元素子节点
 */
export function normalize(node: Node, theme: Theme): IntrinsicNode {
	return normalizeAt(node, theme, 0);
}

function normalizeAt(node: Node, theme: Theme, depth: number): IntrinsicNode {
	if (depth > MAX_DEPTH) {
		throw new Error(
			`Component tree is too deep (over ${MAX_DEPTH} levels); check for a component that renders itself.`,
		);
	}
	if (!isElement(node)) {
		return { type: "text", props: { text: node }, children: [] };
	}
	if (typeof node.type === "function") {
		// 元素类型是「某个具体组件」，这里只关心它能吃下 props 与 children；具体 props 由
		// 调用方（也就是写组件的人）自己声明，引擎不参与校验。
		const component = node.type as (props: Record<string, unknown>) => Node;
		const rendered = component({ ...node.props, theme, children: node.children });
		return normalizeAt(rendered, theme, depth + 1);
	}
	const intrinsic = intrinsicOf(node);
	const children =
		intrinsic === "text"
			? textChildren(node.children)
			: node.children.map((child) => normalizeAt(child, theme, depth + 1));
	return { type: intrinsic, props: node.props, children };
}

function intrinsicOf(node: ElementNode): IntrinsicName {
	if (INTRINSICS.includes(node.type as IntrinsicName)) return node.type as IntrinsicName;
	throw new Error(`Unknown intrinsic element <${String(node.type)}>; expected one of ${INTRINSICS.join(", ")}.`);
}

/** text 原语只接受字符串：出现元素子节点时说明用法错了，报错而不是静默丢弃。 */
function textChildren(children: readonly Node[]): readonly IntrinsicNode[] {
	for (const child of children) {
		if (isElement(child)) {
			throw new Error("A text element accepts strings only; wrap the child in its own text element.");
		}
	}
	return children.map((child) => ({ type: "text", props: { text: child }, children: [] }));
}

/** 读一个数字属性；缺失或类型不对时用默认值。 */
export function numberProp(props: Readonly<Record<string, unknown>>, key: string, fallback = 0): number {
	const value = props[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 读一个字符串属性。 */
export function stringProp(props: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const value = props[key];
	return typeof value === "string" ? value : undefined;
}

/** 读一个布尔属性。 */
export function booleanProp(props: Readonly<Record<string, unknown>>, key: string): boolean {
	return props[key] === true;
}

/** 读 padding：可以是数字，也可以是 `{ x, y }`。 */
export function paddingOf(props: Readonly<Record<string, unknown>>): { readonly x: number; readonly y: number } {
	const value = props["padding"];
	if (typeof value === "number") return { x: Math.max(0, value), y: Math.max(0, value) };
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const x = typeof record["x"] === "number" ? Math.max(0, record["x"]) : 0;
		const y = typeof record["y"] === "number" ? Math.max(0, record["y"]) : 0;
		return { x, y };
	}
	return { x: 0, y: 0 };
}
