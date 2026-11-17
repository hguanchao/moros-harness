import { displayWidth } from "#src/tui/term/index.ts";
import { PANEL } from "#src/tui/app/copy/index.ts";
import {
	type MenuListState,
	ACCENT_COLOR,
	BOLD_OFF,
	HOVER_BG,
	MENU_MAX_VISIBLE,
	PREFIX_WIDTH,
	MUTED_COLOR,
	PANEL_BG,
	RESET,
	SELECTED_TEXT_COLOR,
	TEXT_COLOR,
	menuListHeight,
	menuListLines,
	padEnd,
	padStart,
} from "#src/tui/app/panel/menu-panel.ts";

/**
 * 模型选择面板。
 *
 * 面板固定在输入框上方，只有上下两条横线；中间整块使用灰色背景，选中行再深一档。四列
 * （模型 ID / 名称 / 提供商 / 选中状态）等宽排布；窄终端放不下四列时退回「provider/model
 * + current」的紧凑布局。列宽按全部模型一次算好，滚动时不会因为可见行变化而跳动。
 */

export interface ModelMenuItem {
	readonly provider: string;
	readonly model: string;
	/** providers.json 中的展示名；未配置时为空，面板用 - 占位 */
	readonly name?: string;
	readonly current: boolean;
}

export interface ModelMenuState extends MenuListState {
	readonly items: readonly ModelMenuItem[];
}

/** 相邻两列之间的间距。 */
const GAP = 2;
/** 四列表头能完整放下的最小列宽；再窄退回紧凑布局。 */
const MIN_COLUMN_WIDTH = 8;
const CURRENT_WIDTH = 7;

/** 面板总高度：上边框、可见行与下边框。 */
export function modelMenuHeight(itemCount: number, maxVisible = MENU_MAX_VISIBLE): number {
	return menuListHeight(itemCount, undefined, maxVisible);
}

export function renderModelMenu(
	width: number,
	state: ModelMenuState,
	maxVisible = MENU_MAX_VISIBLE,
): readonly string[] {
	return menuListLines(width, state.items, state, layoutColumns, row, undefined, maxVisible);
}

interface Columns {
	/** true 为四列等宽；false 为窄终端紧凑布局 */
	readonly table: boolean;
	readonly columnWidth: number;
	readonly keyWidth: number;
	/** 0 表示终端太窄，隐藏展示名列 */
	readonly nameWidth: number;
	/** 0 表示终端太窄，连 current 也放不下 */
	readonly currentWidth: number;
}

/** 四列等宽时每列的内容宽度；终端太窄时返回 undefined。 */
function tableColumnWidth(width: number): number | undefined {
	const content = Math.max(1, width - PREFIX_WIDTH);
	const columnWidth = Math.floor((content - 3 * GAP) / 4);
	return columnWidth >= MIN_COLUMN_WIDTH ? columnWidth : undefined;
}

function layoutColumns(width: number, items: readonly ModelMenuItem[]): Columns {
	const columnWidth = tableColumnWidth(width);
	if (columnWidth !== undefined) {
		return { table: true, columnWidth, keyWidth: 0, nameWidth: 0, currentWidth: 0 };
	}

	const currentSegmentWidth = GAP + CURRENT_WIDTH;
	if (width < PREFIX_WIDTH + 1 + currentSegmentWidth) {
		return { table: false, columnWidth: 0, keyWidth: Math.max(1, width - PREFIX_WIDTH), nameWidth: 0, currentWidth: 0 };
	}

	const longestKey = Math.max(1, ...items.map((item) => displayWidth(`${item.provider}/${item.model}`)));
	const keyWidth = Math.min(longestKey, Math.max(1, width - PREFIX_WIDTH - currentSegmentWidth));
	// 为了保住 current 把模型 id 压到几个字符，反而认不出是哪个模型：这时先舍 current
	if (keyWidth < Math.min(longestKey, 8)) {
		return {
			table: false,
			columnWidth: 0,
			keyWidth: Math.min(longestKey, Math.max(1, width - PREFIX_WIDTH)),
			nameWidth: 0,
			currentWidth: 0,
		};
	}
	const remaining = width - PREFIX_WIDTH - keyWidth - currentSegmentWidth;
	const nameWidth = remaining >= GAP + 4 ? remaining - GAP : 0;
	return { table: false, columnWidth: 0, keyWidth, nameWidth, currentWidth: CURRENT_WIDTH };
}

function row(width: number, item: ModelMenuItem, selected: boolean, hovered: boolean, columns: Columns): string {
	const background = selected ? PANEL_BG : hovered ? HOVER_BG : PANEL_BG;
	const prefix = selected ? " › " : "   ";
	const primaryColor = selected ? SELECTED_TEXT_COLOR : TEXT_COLOR;
	const boldOff = selected ? BOLD_OFF : "";
	const prefixOutput = selected ? ` ${ACCENT_COLOR}›${primaryColor} ` : prefix;

	if (columns.table) {
		const cells = [
			padEnd(item.model, columns.columnWidth),
			padEnd(item.name ?? "-", columns.columnWidth),
			padEnd(item.provider, columns.columnWidth),
			padEnd(item.current ? PANEL.current : "", columns.columnWidth),
		];
		const head = `${prefix}${cells.join(" ".repeat(GAP))}`;
		const padding = " ".repeat(Math.max(0, width - displayWidth(head)));
		return `${background}${primaryColor}${prefixOutput}${cells[0]}${boldOff}${" ".repeat(GAP)}${MUTED_COLOR}${cells[1]}${" ".repeat(GAP)}${MUTED_COLOR}${cells[2]}${" ".repeat(GAP)}${ACCENT_COLOR}${cells[3]}${padding}${RESET}`;
	}

	const key = padEnd(`${item.provider}/${item.model}`, columns.keyWidth);
	const name = columns.nameWidth > 0 ? padEnd(displayName(item), columns.nameWidth) : "";
	const current = columns.currentWidth > 0 ? padStart(item.current ? PANEL.current : "", columns.currentWidth) : "";
	const nameSegment = columns.nameWidth > 0 ? `${" ".repeat(GAP)}${name}` : "";
	const currentSegment = columns.currentWidth > 0 ? `${" ".repeat(GAP)}${current}` : "";
	const head = `${prefix}${key}${nameSegment}${currentSegment}`;
	const padding = " ".repeat(Math.max(0, width - displayWidth(head)));
	const nameOutput = columns.nameWidth > 0 ? `${" ".repeat(GAP)}${MUTED_COLOR}${name}` : "";
	const currentOutput = columns.currentWidth > 0 ? `${" ".repeat(GAP)}${ACCENT_COLOR}${current}` : "";

	return `${background}${primaryColor}${prefixOutput}${key}${boldOff}${nameOutput}${currentOutput}${padding}${RESET}`;
}

/** 展示名与 id 相同时留空，避免紧凑布局里同一行重复两遍。 */
function displayName(item: ModelMenuItem): string {
	const key = `${item.provider}/${item.model}`;
	const name = item.name ?? "";
	return name.length === 0 || name === item.model || name === key ? "" : name;
}
