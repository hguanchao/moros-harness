import { THINKING_LEVELS, type ThinkingLevel } from "../contract/config.ts";
import { displayWidth } from "../../term/index.ts";
import { EFFORT_DESCRIPTIONS } from "../copy/index.ts";
import {
	type MenuListState,
	MENU_MAX_VISIBLE,
	PREFIX_WIDTH,
	menuListHeight,
	menuListLines,
	padEnd,
	padStart,
	ACCENT_COLOR,
	BOLD_OFF,
	HOVER_BG,
	MUTED_COLOR,
	PANEL_BG,
	RESET,
	SELECTED_TEXT_COLOR,
	TEXT_COLOR,
} from "./menu-panel.ts";

/**
 * 思考等级选择面板。
 *
 * 级别清单直接取配置层的 THINKING_LEVELS，避免界面和校验各维护一份。布局与模型面板同源：
 * 宽终端四栏等宽（级别 / 描述跨两栏 / current），列宽由终端宽度算；窄终端退回模型面板的
 * 紧凑布局（级别按内容定宽、描述吃剩余、current 贴行尾）。描述比级别名长得多，所以让它
 * 跨两栏而不是三列等宽硬切。
 */

export interface EffortMenuState extends MenuListState {
	readonly current: ThinkingLevel;
	/** 级别清单与 THINKING_LEVELS 相同；收进状态让五种面板的公共操作不必特判 */
	readonly items: readonly ThinkingLevel[];
}

/** 与模型面板一致：列间两列间距。 */
const GAP = 2;
const CURRENT_WIDTH = 7;
/** 四栏表格每栏下限：两倍栏宽要放得下最长的等级说明（53 列）。 */
const MIN_COLUMN_WIDTH = 26;

interface Columns {
	readonly levelWidth: number;
	/** 0 表示终端太窄，不显示说明 */
	readonly descriptionWidth: number;
	/** 0 表示终端太窄，不显示 current 标记 */
	readonly currentWidth: number;
	/** 宽终端表格里 current 是独立栏，左对齐；紧凑布局才右对齐贴住行尾 */
	readonly currentAlign: "left" | "right";
}

export function effortMenuHeight(maxVisible = MENU_MAX_VISIBLE): number {
	return menuListHeight(THINKING_LEVELS.length, undefined, maxVisible);
}

export function renderEffortMenu(
	width: number,
	state: EffortMenuState,
	maxVisible = MENU_MAX_VISIBLE,
): readonly string[] {
	return menuListLines(
		width,
		THINKING_LEVELS,
		state,
		layoutColumns,
		(panelWidth, level, selected, hovered, columns) =>
			row(panelWidth, level, selected, hovered, level === state.current, columns),
		undefined,
		maxVisible,
	);
}

function layoutColumns(width: number): Columns {
	const content = Math.max(1, width - PREFIX_WIDTH);
	const columnWidth = Math.floor((content - GAP * 3) / 4);
	if (columnWidth >= MIN_COLUMN_WIDTH) {
		// 四栏：级别 / 描述（跨两栏）/ current。描述占两栏才不会被 26 列硬截断。
		return {
			levelWidth: columnWidth,
			descriptionWidth: columnWidth * 2 + GAP,
			currentWidth: columnWidth,
			currentAlign: "left",
		};
	}

	// 紧凑布局照模型面板：级别按内容定宽，描述吃剩余，current 固定 7 列贴行尾；
	// 放不下 current 就先舍它，描述短到 4 列以下时也不显示。
	const levelWidth = Math.max(...THINKING_LEVELS.map(displayWidth));
	const currentWidth = width >= PREFIX_WIDTH + levelWidth + GAP * 2 + CURRENT_WIDTH ? CURRENT_WIDTH : 0;
	const descriptionWidth = Math.max(0, content - levelWidth - GAP - (currentWidth > 0 ? GAP + currentWidth : 0));
	return {
		levelWidth,
		descriptionWidth: descriptionWidth >= 4 ? descriptionWidth : 0,
		currentWidth,
		currentAlign: "right",
	};
}

function row(
	width: number,
	level: ThinkingLevel,
	selected: boolean,
	hovered: boolean,
	current: boolean,
	columns: Columns,
): string {
	const background = selected ? PANEL_BG : hovered ? HOVER_BG : PANEL_BG;
	const prefix = selected ? " › " : "   ";
	const primaryColor = selected ? SELECTED_TEXT_COLOR : TEXT_COLOR;
	const boldOff = selected ? BOLD_OFF : "";
	const prefixOutput = selected ? ` ${ACCENT_COLOR}›${primaryColor} ` : prefix;
	const levelText = padEnd(level, columns.levelWidth);
	const description =
		columns.descriptionWidth > 0 ? padEnd(EFFORT_DESCRIPTIONS[level] ?? "", columns.descriptionWidth) : "";
	const descriptionSegment = columns.descriptionWidth > 0 ? `${" ".repeat(GAP)}${description}` : "";
	const marker = current ? "current" : "";
	const currentText =
		columns.currentWidth === 0
			? ""
			: columns.currentAlign === "left"
				? padEnd(marker, columns.currentWidth)
				: padStart(marker, columns.currentWidth);
	const currentSegment = columns.currentWidth > 0 ? `${" ".repeat(GAP)}${currentText}` : "";
	const head = `${prefix}${levelText}${descriptionSegment}${currentSegment}`;
	const padding = " ".repeat(Math.max(0, width - displayWidth(head)));
	const descriptionOutput = columns.descriptionWidth > 0 ? `${" ".repeat(GAP)}${MUTED_COLOR}${description}` : "";
	const currentOutput = columns.currentWidth > 0 ? `${" ".repeat(GAP)}${ACCENT_COLOR}${currentText}` : "";

	return `${background}${primaryColor}${prefixOutput}${levelText}${boldOff}${descriptionOutput}${currentOutput}${padding}${RESET}`;
}
