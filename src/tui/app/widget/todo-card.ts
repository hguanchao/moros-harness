import { formatDuration } from "#src/tui/app/contract/format.ts";
import { countSegments, moreItems, taskLabel } from "#src/tui/app/copy/index.ts";
import type { AnimationFrame } from "#src/tui/app/render/sweep.ts";
import { THEME } from "#src/tui/app/render/theme.ts";
import { cardFinished, cardLines, cardPanelLines, type CardProps } from "#src/tui/kit/index.ts";

/**
 * 任务卡片：类型、参数解析与文案绑定。
 *
 * 未收尾的列表只在常驻面板显示；全部完成或失败后整张卡落进对话流，面板随之清空。
 * 一次 todo 调用就是一张卡片，卡片自己不放状态——「当前列表」永远是会话里最后一次
 * 调用的参数，续聊与回填都靠会话重放。
 *
 * 排版在 `src/tui/kit` 的 `Card`：这里只把业务字段翻成「标签 + 计数 + 条目」。
 */

/** 任务条目的状态;failed 表示这一步无法完成，与完成、进行中、待办并列。 */
type TranscriptTodoStatus = "pending" | "in_progress" | "completed" | "failed";

interface TranscriptTodoItem {
	readonly content: string;
	readonly status: TranscriptTodoStatus;
}

/**
 * 任务卡片：一次 todo 调用的完整快照。
 *
 * 条目顺序保持模型给出的顺序——顺序本身就是执行顺序。running 由界面在回合结束时改回
 * false(与思考块同一先例):运行期间当前任务行是转圈加扫光，之后退为静态形态。
 * collapsed 是收起态，条目多时默认收起，双击头行切换。taskStartedAt 是当前进行中
 * 任务的起点，由界面在卡片创建时写入(同一任务在上一张卡片里也进行时继承起点),
 * 用于头行与折叠头行的耗时显示。
 */
export interface TranscriptTodo {
	readonly kind: "todo";
	/** 模型对这次更新的说明；当前排版不占行 */
	readonly explanation?: string;
	readonly items: readonly TranscriptTodoItem[];
	running?: boolean;
	collapsed?: boolean;
	taskStartedAt?: number;
}

/** 任务卡头行的固定标签。 */
const TODO_HEADER_LABEL = "Tasks";
/** 条目超过这个数默认收起：短列表一眼全览，长列表只留状态行。 */
const TODO_EXPAND_MAX_ITEMS = 5;

/** 任务表是否已经收尾：非空且没有待办、没有进行中。 */
export function todoCardFinished(card: TranscriptTodo): boolean {
	return cardFinished(card.items);
}

/** 头行计数段：运行→完成→失败→待办，没有的段不显示。 */
function todoCountSegments(card: TranscriptTodo): string {
	let running = 0;
	let done = 0;
	let failed = 0;
	let pending = 0;
	for (const item of card.items) {
		if (item.status === "in_progress") running += 1;
		else if (item.status === "completed") done += 1;
		else if (item.status === "failed") failed += 1;
		else pending += 1;
	}

	return countSegments({ running, done, failed, pending });
}

/** 业务卡片到组件属性的翻译：文案与耗时都在这里定，组件只管排版。 */
function cardPropsOf(card: TranscriptTodo): CardProps {
	const counts = todoCountSegments(card);
	// 耗时只在运行中有意义；未开始计时时连括号都不出现
	const started = card.running === true && card.taskStartedAt !== undefined;
	return {
		label: TODO_HEADER_LABEL,
		counts,
		items: card.items.map((item, index) => ({
			label: taskLabel(index + 1),
			text: item.content,
			status: item.status,
		})),
		...(started ? { elapsed: `(${formatDuration(Date.now() - (card.taskStartedAt ?? 0))})` } : {}),
		...(card.running === true ? { running: true } : {}),
		...(card.collapsed === true ? { collapsed: true } : {}),
	};
}

/**
 * 从工具调用参数解析任务卡片。
 *
 * tool_start 在参数校验之前发出，参数可能形状不对：任何一处不合预期都返回 undefined,
 * 由调用方按普通工具行回退，让校验阶段的错误信息有行可挂。空白内容同样视为不合预期。
 * 收起默认值在这里定：实时与历史回填共用同一条规则。
 */
export function todoCardFromArgs(args: Record<string, unknown>): TranscriptTodo | undefined {
	const todos = args["todos"];
	if (!Array.isArray(todos)) return undefined;

	const items: TranscriptTodoItem[] = [];
	for (const entry of todos) {
		if (typeof entry !== "object" || entry === null) return undefined;
		const content = (entry as Record<string, unknown>)["content"];
		const status = (entry as Record<string, unknown>)["status"];
		if (typeof content !== "string" || content.trim().length === 0) return undefined;
		if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "failed") {
			return undefined;
		}
		items.push({ content, status });
	}

	const explanation = args["explanation"];
	if (explanation !== undefined && typeof explanation !== "string") return undefined;
	return {
		kind: "todo",
		...(explanation === undefined || explanation.trim().length === 0 ? {} : { explanation }),
		items,
		collapsed: items.length > TODO_EXPAND_MAX_ITEMS,
	};
}

/** 常驻面板最多显示的条目数:面板只回答「进行到哪」,条目再多也只列到上限。 */
export const TODO_PANEL_MAX_ITEMS = 8;

/**
 * 已经收尾的任务卡落到对话流里的屏幕行。
 *
 * 与面板共用同一套头行和条目排版，但不再动画：全部状态都已静止。条目多时
 * 默认收起（与面板同一条规则），双击头行展开。
 */
export function todoCardLines(card: TranscriptTodo, width: number): readonly string[] {
	return cardLines(cardPropsOf(card), width, THEME);
}

/**
 * 常驻面板的屏幕行：未收尾的任务卡唯一的显示位置。
 *
 * 头行 + 条目单行截断(不折行,面板不挤压对话流)。收起状态、运行标记与动画都由同一个
 * 卡对象决定；收尾后的卡片不再进面板。条目超上限时显示剩余数。
 */
export function todoPanelLines(card: TranscriptTodo, width: number, frame: AnimationFrame): readonly string[] {
	return cardPanelLines(cardPropsOf(card), width, THEME, frame, {
		maxItems: TODO_PANEL_MAX_ITEMS,
		more: moreItems,
	});
}
