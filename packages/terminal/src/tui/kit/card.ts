import { displayWidth, fitToWidth, sanitizeForDisplay, truncateToWidth, type Theme } from "../term/index.ts";
import { swept, type AnimationFrame } from "./sweep.ts";

/**
 * 任务卡片：头行 + 若干状态条目。
 *
 * 卡片只认「标签、计数、条目」这三样已经格式化好的文本：`Tasks` 还是 `任务`、`1 running`
 * 怎么拼、`Task 3` 叫什么，全在调用方。这里负责缩进、标记、配色、截断与扫光。
 *
 * 两种排版共用头行：展开态把当前条目交给清单，头行只回答全局进度；折叠态没有清单行，
 * 运行中的条目名才回到头行。窄屏时条目名先让步，计数最后才截断。
 */

/** 条目状态；failed 表示这一步无法完成，与完成、进行中、待办并列。 */
export type CardItemStatus = "pending" | "in_progress" | "completed" | "failed";

/** 卡片条目：标签与正文都由调用方给，正文会被清洗与截断。 */
export interface CardItem {
	readonly label: string;
	readonly text: string;
	readonly status: CardItemStatus;
}

export interface CardProps {
	/** 头行标签 */
	readonly label: string;
	/** 已格式化的状态计数；空串表示不显示 */
	readonly counts?: string;
	/** 已格式化的耗时，含括号；只在运行中显示 */
	readonly elapsed?: string;
	readonly items: readonly CardItem[];
	readonly collapsed?: boolean;
	readonly running?: boolean;
}

/** 头行与条目的缩进：与对话流的回复正文、工具行保持同一列起头。 */
const INDENT = "  ";
/** 头行标记：与工具行的 › 同款。 */
const MARKER = "›";
/** 条目比头行正文多缩进两列，标记正对头行标签的起头。 */
const ITEM_INDENT = `${INDENT}  `;
/** 加粗：进行中的条目是整卡最亮的一项。 */
const BOLD = "\x1b[1m";
/** 折叠头行里运行中条目的显示宽度上限，超出省略。 */
const RUNNING_NAME_WIDTH = 30;

/** 条目是否已经收尾：非空且没有待办、没有进行中。 */
export function cardFinished(items: readonly { readonly status: CardItemStatus }[]): boolean {
	return items.length > 0 && items.every((item) => item.status === "completed" || item.status === "failed");
}

/**
 * 卡片头行：标签 + 状态计数 + 耗时；折叠且运行中时末尾带转圈条目名。
 *
 * `frame` 缺省表示静止（收尾后的卡片），此时不画转圈。
 */
export function cardHeaderLine(props: CardProps, width: number, theme: Theme, frame?: AnimationFrame): string {
	const label = `${INDENT}${MARKER} ${props.label}`;
	const counts = props.counts ?? "";
	const runningItem = props.items.find((item) => item.status === "in_progress");
	const isRunning = props.running === true && runningItem !== undefined;
	const elapsed = isRunning && props.elapsed !== undefined ? ` ${props.elapsed}` : "";
	const baseText = counts.length === 0 ? "" : `  ${counts}${elapsed}`;
	const available = Math.max(0, width - displayWidth(label));
	const base = truncateToWidth(baseText, available);

	let namePart = "";
	let nameWidth = 0;
	if (props.collapsed === true && isRunning && runningItem !== undefined && frame !== undefined) {
		const budget = Math.max(0, available - displayWidth(base) - displayWidth(`  ${frame.spinner} `));
		if (budget >= 2) {
			const name = fitToWidth(sanitizeForDisplay(runningItem.text), Math.min(RUNNING_NAME_WIDTH, budget));
			nameWidth = displayWidth(name);
			namePart = `  ${theme.accent}${BOLD}${frame.spinner} ${swept(name, frame.sweepPhase, theme.accentDim, theme.accentRgb)}`;
		}
	}

	const used =
		displayWidth(label) +
		displayWidth(base) +
		(nameWidth === 0 ? 0 : 2 + displayWidth(frame?.spinner ?? " ") + 1 + nameWidth);
	const padding = " ".repeat(Math.max(0, width - used));
	return `${theme.accent}${label}${theme.reset}${theme.textSecondary}${base}${theme.reset}${namePart}${padding}`;
}

/**
 * 条目行：标记 + 标签 + 正文，按状态配色。
 *
 * 带帧时用转圈与扫光替换静态半圆；其余状态都是静止的。
 */
export function cardItemLine(item: CardItem, width: number, theme: Theme, frame?: AnimationFrame): string {
	const label = item.label;
	// 标记占两列（符号 + 空格），标签与正文之间也隔两列
	const budget = Math.max(0, width - displayWidth(ITEM_INDENT) - 2 - displayWidth(label) - 2);
	const summary = truncateToWidth(sanitizeForDisplay(item.text), budget);

	if (item.status === "completed") {
		return `${ITEM_INDENT}${theme.accent}● ${theme.reset}${theme.accent}${BOLD}${label}${theme.reset}  ${theme.textSecondary}${summary}${theme.reset}`;
	}
	if (item.status === "failed") {
		return `${ITEM_INDENT}${theme.error}× ${label}  ${summary}${theme.reset}`;
	}
	if (item.status === "pending") {
		return `${ITEM_INDENT}${theme.textSecondary}○ ${theme.reset}${theme.accent}${BOLD}${label}${theme.reset}  ${theme.textSecondary}${summary}${theme.reset}`;
	}
	if (frame !== undefined) {
		const visible = `${frame.spinner} ${label}  ${summary}`;
		return `${ITEM_INDENT}${theme.accent}${BOLD}${swept(visible, frame.sweepPhase, theme.accentDim, theme.accentRgb)}`;
	}
	return `${ITEM_INDENT}${theme.accent}${BOLD}◐ ${label}  ${summary}${theme.reset}`;
}

/**
 * 收尾后的卡片落到对话流里的屏幕行。
 *
 * 不再动画：所有状态都已静止。条目多时按 `collapsed` 只留头行。
 */
export function cardLines(props: CardProps, width: number, theme: Theme): readonly string[] {
	const head = cardHeaderLine(props, width, theme);
	if (props.collapsed === true) return [head];
	return [head, ...props.items.map((item) => cardItemLine(item, width, theme))];
}

export interface CardPanelOptions {
	/** 最多显示几条 */
	readonly maxItems: number;
	/** 剩余条数的文案；条数由组件算出来交给调用方格式化 */
	readonly more: (hidden: number) => string;
}

/**
 * 常驻面板的屏幕行：未收尾的卡片唯一的显示位置。
 *
 * 头行 + 条目单行截断（不折行，面板不挤压对话流）。条目超上限时显示剩余数。
 */
export function cardPanelLines(
	props: CardProps,
	width: number,
	theme: Theme,
	frame: AnimationFrame,
	options: CardPanelOptions,
): readonly string[] {
	if (props.items.length === 0 || cardFinished(props.items)) return [];

	const head = cardHeaderLine(props, width, theme, frame);
	if (props.collapsed === true) return [head];

	const itemFrame = props.running === true ? frame : undefined;
	const visible = props.items.slice(0, Math.max(0, options.maxItems));
	const lines = [head, ...visible.map((item) => cardItemLine(item, width, theme, itemFrame))];
	const hidden = props.items.length - visible.length;
	if (hidden > 0) {
		lines.push(`${ITEM_INDENT}${theme.textSubtle}${options.more(hidden)}${theme.reset}`);
	}
	return lines;
}
