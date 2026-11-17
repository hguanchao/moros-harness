import { displayWidth, fitToWidth, type Theme } from "#src/tui/term/index.ts";
import { virtualWindow } from "#src/tui/kit/virtual.ts";

/**
 * 菜单面板骨架。
 *
 * 上边框（带数量标签）+ 可见条目 + 下边框；滚动窗口、可见行裁剪与边框顺序只写这一份，
 * 各面板只提供自己的列宽计算与单行排版。颜色全部从主题取，库内不预设配色。
 */

/** 面板最多显示的条目行数。 */
export const MENU_MAX_VISIBLE = 8;

/** 选中行前缀宽度；未选中行用等宽空格占位，正文因此对齐。 */
export const PREFIX_WIDTH = 3;

/** 上边框数量右侧固定的横线数。 */
const TAIL_DASHES = 4;

/** 面板附加行：无匹配提示。 */
export interface MenuListOptions {
	/** 没有条目时显示的一句话；省略时不画空态行 */
	readonly empty?: string | undefined;
}

/** 面板列表的公共状态；五种面板的条目状态都扩展这一份。 */
export interface MenuListState {
	cursor: number;
	scrollTop: number;
	/** 指针悬停的条目；只影响底色，不改变 cursor。移出列表时显式清成 undefined */
	hover?: number | undefined;
	/** 指针按下的条目；抬起时若仍落在同一项上才算一次点击 */
	pressed?: number | undefined;
}

/** 面板总高度：上边框、可见行（或空态）与下边框。 */
export function menuListHeight(
	itemCount: number,
	options: MenuListOptions = {},
	maxVisible = MENU_MAX_VISIBLE,
): number {
	const visible = Math.min(Math.max(0, itemCount), maxVisible);
	const empty = itemCount === 0 && options.empty !== undefined ? 1 : 0;
	return visible + empty + 2;
}

/**
 * 移动列表光标并保持可见。
 *
 * 键盘移动首尾相接；滚轮和翻页用不循环的夹取，避免滚过头时突然跳回另一端。
 */
export function moveMenuSelection(
	menu: { cursor: number; scrollTop: number },
	delta: number,
	count: number,
	wrap: boolean,
	maxVisible = MENU_MAX_VISIBLE,
): void {
	if (count <= 0) {
		menu.cursor = 0;
		menu.scrollTop = 0;
		return;
	}
	const next = menu.cursor + delta;
	menu.cursor = wrap ? ((next % count) + count) % count : Math.min(count - 1, Math.max(0, next));
	menu.scrollTop = keepVisible(menu.scrollTop, menu.cursor, count, maxVisible);
}

/** 让光标始终落在可见窗口内。 */
export function keepVisible(
	scrollTop: number,
	cursor: number,
	itemCount: number,
	maxVisible = MENU_MAX_VISIBLE,
): number {
	const visible = Math.min(Math.max(0, itemCount), maxVisible);
	const maxTop = Math.max(0, itemCount - visible);
	let top = Math.min(Math.max(0, scrollTop), maxTop);
	if (cursor < top) top = cursor;
	if (cursor >= top + visible) top = cursor - visible + 1;
	return top;
}

/**
 * 画出「上边框 + 可见条目（或空态）+ 下边框」的完整面板。
 *
 * 五个选择面板的滚动窗口、可见行裁剪与边框顺序完全一致，只有列宽计算与单行排版不同，
 * 那两处由调用方传入。
 *
 * @param theme 主题取值
 * @param width 面板总列宽
 * @param items 条目
 * @param state 光标与滚动状态
 * @param layout 按宽度算列宽；一次算好，滚动时不跳动
 * @param row 单行排版
 * @param options 空态文案
 * @param maxVisible 最多可见行数
 */
export function menuListLines<T, L>(
	theme: Theme,
	width: number,
	items: readonly T[],
	state: MenuListState,
	layout: (width: number, items: readonly T[]) => L,
	row: (width: number, item: T, selected: boolean, hovered: boolean, layout: L) => string,
	options: MenuListOptions = {},
	maxVisible = MENU_MAX_VISIBLE,
): readonly string[] {
	const window = virtualWindow({
		total: items.length,
		height: maxVisible,
		scrollTop: keepVisible(state.scrollTop, state.cursor, items.length, maxVisible),
	});
	const visibleCount = window.height;
	const columns = layout(width, items);
	const lines: string[] = [topBorder(theme, width, Math.min(state.cursor + 1, items.length), items.length, maxVisible)];

	if (visibleCount === 0) {
		if (options.empty !== undefined) lines.push(emptyLine(theme, width, options.empty));
	} else {
		for (let index = window.start; index < window.end; index += 1) {
			const item = items[index];
			if (item === undefined) break;
			lines.push(row(width, item, index === state.cursor, index === state.hover && index !== state.cursor, columns));
		}
	}

	lines.push(bottomBorder(theme, width));
	return lines;
}

/** 上边框右侧的数量；数量变化时只伸缩左侧长横线。 */
function topBorder(theme: Theme, width: number, position: number, count: number, maxVisible: number): string {
	// 超过一屏时显示「当前位置/总数」，滚动后能看出自己在哪里
	const label = count > maxVisible ? ` ${position}/${count} ` : ` ${count} `;
	const labelWidth = displayWidth(label);
	const tail = Math.min(TAIL_DASHES, Math.max(0, width - labelWidth));
	const left = Math.max(0, width - labelWidth - tail);
	return `${theme.border}${"─".repeat(left)}${theme.textSubtle}${label}${theme.border}${"─".repeat(tail)}${theme.reset}`;
}

function bottomBorder(theme: Theme, width: number): string {
	return `${theme.border}${"─".repeat(width)}${theme.reset}`;
}

/** 空态行：面板保留，告诉使用者是没匹配而不是补全坏了。 */
function emptyLine(theme: Theme, width: number, text: string): string {
	const visible = fitToWidth(`  ${text}`, width);
	const padding = " ".repeat(Math.max(0, width - displayWidth(visible)));
	return `${theme.surface}${theme.textSubtle}${visible}${padding}${theme.reset}`;
}

/** 补到指定宽度；放不下时截断并补省略号。 */
export function padEnd(text: string, width: number): string {
	const visible = fitToWidth(text, width);
	return visible + " ".repeat(Math.max(0, width - displayWidth(visible)));
}

/** 右对齐补到指定宽度。 */
export function padStart(text: string, width: number): string {
	const visible = fitToWidth(text, width);
	return " ".repeat(Math.max(0, width - displayWidth(visible))) + visible;
}
