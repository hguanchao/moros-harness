import type { Theme } from "../term/index.ts";
import type { Node } from "./element.ts";
import { fit } from "./fit.ts";
import { layout, measure } from "./layout.ts";
import { normalize } from "./normalize.ts";
import { paint } from "./paint.ts";

/**
 * 把一棵元素树渲染成行。
 *
 * 这是组件库对外的唯一渲染入口：纯函数，输入树与宽度、输出整帧行。没有隐藏状态、没有
 * 上一帧依赖，因此可以直接做黄金帧断言；应用侧只需要把行交给终端的整帧写入器。
 */

/** 渲染参数。 */
export interface RenderOptions {
	/** 可用列数；超出部分被裁剪 */
	readonly width: number;
	/** 输出行数；省略时按内容高度，给出时不足补空行、超出裁掉 */
	readonly height?: number | undefined;
	/** 主题取值；由应用注入 */
	readonly theme: Theme;
}

/**
 * 渲染整棵树。
 *
 * @param root 根节点
 * @param options 宽度、可选高度与主题
 * @returns 每行宽度正好等于 `width` 的字符串数组，行数等于 `height` 或内容高度
 * @throws 内建原语名非法、组件递归过深、text 原语下出现元素子节点
 */
export function renderToLines(root: Node, options: RenderOptions): readonly string[] {
	const width = Math.max(0, Math.floor(options.width));
	const intrinsic = normalize(root, options.theme);
	const measured = measure(intrinsic, width);
	const height = options.height === undefined ? measured.height : Math.max(0, Math.floor(options.height));
	// 定位按调用方给的高度铺，而不是取「内容高度与目标高度的较大者」：页面这类内容的动作条是
	// 钉在视口底部的，先按内容高度铺会把动作条推出屏幕，最后一步裁剪只会裁掉它。
	const tree = layout(intrinsic, { x: 0, y: 0, width, height });
	return fit(paint(tree, options.theme), width, height);
}
