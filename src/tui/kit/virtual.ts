import { el, type ComponentProps, type Node } from "#src/tui/kit/element.ts";

/**
 * 虚拟列表：长内容只画视口那几行。
 *
 * 窗口计算是纯函数，与「条目长什么样」完全分开——条目可能来自组件树，也可能是一堆已经
 * 排好版的成品行。`VirtualList` 是后者的便捷入口：把成品行交给 `raw` 原语参与布局。
 */

/** 可见窗口；`end` 不含，前后留白用于滚动条与吸顶。 */
export interface VirtualWindow {
	readonly start: number;
	readonly end: number;
	/** 实际交给布局的行数（含 overscan，内容不足时小于请求高度） */
	readonly height: number;
	/** 窗口上方还有多少行 */
	readonly before: number;
	/** 窗口下方还有多少行 */
	readonly after: number;
}

export interface VirtualWindowOptions {
	readonly total: number;
	readonly height: number;
	readonly scrollTop?: number;
	/** 有光标时把窗口挪到能看见它的位置 */
	readonly cursor?: number;
	/** 视口外多渲染几行，滚动时少一次重排 */
	readonly overscan?: number;
}

/**
 * 算可见窗口。
 *
 * `height` 先按内容总量收窄，避免短列表被补进一堆空行；`scrollTop` 夹在合法范围内，再按
 * `cursor` 前后推窗口。所有下标都不会越界，调用方可以放心 `slice(start, end)`。
 */
export function virtualWindow(options: VirtualWindowOptions): VirtualWindow {
	const total = Math.max(0, Math.floor(options.total));
	const height = Math.min(total, Math.max(0, Math.floor(options.height)));
	const maxTop = Math.max(0, total - height);
	let top = Math.min(Math.max(0, Math.floor(options.scrollTop ?? 0)), maxTop);

	const cursor = options.cursor;
	if (cursor !== undefined) {
		const at = Math.max(0, Math.min(total - 1, Math.floor(cursor)));
		if (at < top) top = at;
		if (at >= top + height) top = at - height + 1;
		top = Math.min(Math.max(0, top), maxTop);
	}

	const overscan = Math.max(0, Math.floor(options.overscan ?? 0));
	const start = Math.max(0, top - overscan);
	const end = Math.min(total, top + height + overscan);
	return {
		start,
		end,
		height: Math.max(0, end - start),
		before: start,
		after: Math.max(0, total - end),
	};
}

/** 虚拟列表组件：只把窗口内的成品行交给布局引擎。 */
export interface VirtualListProps {
	readonly lines: readonly string[];
	readonly height: number;
	readonly scrollTop?: number;
	readonly cursor?: number;
	readonly overscan?: number;
}

export function VirtualList(props: VirtualListProps & ComponentProps): Node {
	const { theme: _theme, ...rest } = props;
	const window = virtualWindow({
		total: rest.lines.length,
		height: rest.height,
		...(rest.scrollTop === undefined ? {} : { scrollTop: rest.scrollTop }),
		...(rest.cursor === undefined ? {} : { cursor: rest.cursor }),
		...(rest.overscan === undefined ? {} : { overscan: rest.overscan }),
	});
	return el("raw", { lines: rest.lines.slice(window.start, window.end) });
}
