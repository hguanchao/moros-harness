import {
	MENU_MAX_VISIBLE,
	PREFIX_WIDTH,
	keepVisible,
	menuListHeight,
	menuListLines as kitMenuListLines,
	moveMenuSelection,
	padEnd,
	padStart,
	type MenuListOptions,
	type MenuListState,
} from "../../kit/index.ts";
import { THEME } from "../render/theme.ts";

/**
 * 菜单面板的应用绑定。
 *
 * 骨架（边框、滚动窗口、可见行裁剪）在 `src/tui/kit`；这里只做两件事：把本应用的调色板
 * 传给组件，以及保留补全触发的片段扫描（它与输入框、补全面板的交互绑在一起，不属于通用
 * 列表）。
 */

export { MENU_MAX_VISIBLE, PREFIX_WIDTH, keepVisible, menuListHeight, moveMenuSelection, padEnd, padStart };
export type { MenuListOptions, MenuListState };

/** 浮起表面：提示块与菜单面板。 */
export const PANEL_BG = THEME.surface;
/** 悬停行底色；只表示指针位置，不改变选中项。 */
export const HOVER_BG = THEME.hoverBg;
export const TEXT_COLOR = THEME.textPrimary;
export const MUTED_COLOR = THEME.textSecondary;
export const SUBTLE_COLOR = THEME.textSubtle;
export const DISABLED_COLOR = THEME.textDisabled;
export const ACCENT_COLOR = THEME.accent;
export const SELECTED_TEXT_COLOR = THEME.selectedText;
export const BOLD_OFF = THEME.boldOff;
export const BORDER_COLOR = THEME.border;
export const RESET = THEME.reset;

/** 画一个菜单面板；配色由本应用注入。 */
export function menuListLines<T, L>(
	width: number,
	items: readonly T[],
	state: MenuListState,
	layout: (width: number, items: readonly T[]) => L,
	row: (width: number, item: T, selected: boolean, hovered: boolean, layout: L) => string,
	options: MenuListOptions = {},
	maxVisible = MENU_MAX_VISIBLE,
): readonly string[] {
	return kitMenuListLines(THEME, width, items, state, layout, row, options, maxVisible);
}

/** 从光标处回扫触发符（@ / $）圈出的补全片段。 */
export interface TriggerToken {
	readonly start: number;
	readonly end: number;
	/** 触发符到光标之间的已输入内容 */
	readonly query: string;
}

/**
 * 定位光标所在的补全片段：回扫到行首或空白找到触发符，向前扫描到片段终止字符。
 *
 * @param endOfToken 片段继续延展的判定（如 at 片段遇空白终止、技能片段只吃字母数字）
 * @param validateQuery 光标前的内容不合法时整体不触发（如技能片段只允许安全字符）
 */
export function findTriggerToken(
	text: string,
	cursor: number,
	trigger: string,
	endOfToken: (char: string) => boolean,
	validateQuery?: (query: string) => boolean,
): TriggerToken | undefined {
	const position = Math.min(Math.max(0, cursor), text.length);
	if (position === 0) return undefined;

	let start = position - 1;
	while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
	if (text[start] !== trigger) return undefined;

	const query = text.slice(start + 1, position);
	if (validateQuery !== undefined && !validateQuery(query)) return undefined;

	let end = position;
	while (end < text.length && endOfToken(text[end] ?? "")) end += 1;
	return { start, end, query };
}
