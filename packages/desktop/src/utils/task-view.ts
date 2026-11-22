/**
 * 任务列表（TODO）与子代理的视图投影纯函数。
 *
 * 语义镜像终端 TUI（packages/terminal/src/tui/app/widget/todo-card.ts 与
 * transcript/subagent.ts），但只处理普通 JS 值，不依赖屏幕行/主题，便于桌面端单测。
 * 核心数据（todo 工具参数、subagent 事件）已在会话事件流中，本模块只做解析与聚合。
 */

/** TODO 条目状态；与 core 的 todo 工具 schema 保持一致（4 态）。 */
export type TodoStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TodoItem {
	readonly content: string;
	readonly status: TodoStatus;
}

export interface TodoView {
	readonly items: readonly TodoItem[];
	readonly explanation?: string;
	/** 条目超过该数量时默认折叠。 */
	readonly collapsed?: boolean;
}

export interface TodoCounts {
	readonly running: number;
	readonly done: number;
	readonly failed: number;
	readonly pending: number;
}

export type SubagentStatus = "running" | "done" | "failed";

export interface SubagentMember {
	readonly callId: string;
	readonly task: string;
	readonly status: SubagentStatus;
	readonly steps?: number;
	readonly totalTokens?: number;
	readonly durationMs?: number;
	readonly failure?: string;
}

export interface SubagentGroup {
	readonly members: readonly SubagentMember[];
	/** 组内耗时；运行中可由调用方按当前时间重算。 */
	readonly durationMs?: number;
	/** 组内 token 合计。 */
	readonly totalTokens?: number;
}

/** 条目超过此数量时任务卡默认折叠（与终端 TODO_EXPAND_MAX_ITEMS 一致）。 */
const TODO_EXPAND_MAX_ITEMS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "failed";
}

/**
 * 从 `todo` 工具调用参数解析任务卡视图。
 *
 * 全有或全无：任一处形状不合预期即返回 undefined，由调用方按普通工具行回退；
 * 空数组是合法结果（表示清空列表）；条目超过 5 项默认折叠。
 */
export function todoFromArgs(args: Record<string, unknown>): TodoView | undefined {
	const todos = args["todos"];
	if (!Array.isArray(todos)) return undefined;

	const items: TodoItem[] = [];
	for (const entry of todos) {
		if (!isRecord(entry)) return undefined;
		const content = entry["content"];
		const status = entry["status"];
		if (typeof content !== "string" || content.trim().length === 0) return undefined;
		if (!isTodoStatus(status)) return undefined;
		items.push({ content, status });
	}

	const explanation = args["explanation"];
	if (explanation !== undefined && typeof explanation !== "string") return undefined;
	return {
		items,
		...(explanation === undefined || explanation.trim().length === 0 ? {} : { explanation }),
		...(items.length > TODO_EXPAND_MAX_ITEMS ? { collapsed: true } : {}),
	};
}

/**
 * 任务列表是否已收尾：非空且没有 pending / in_progress。
 * 空表不是"已收尾"（终端语义：空表表示清空，不落对话流）。
 */
export function todoFinished(items: readonly TodoItem[]): boolean {
	return items.length > 0 && items.every((item) => item.status === "completed" || item.status === "failed");
}

/** 统计各状态条目数。 */
export function todoCounts(items: readonly TodoItem[]): TodoCounts {
	let running = 0;
	let done = 0;
	let failed = 0;
	let pending = 0;
	for (const item of items) {
		if (item.status === "in_progress") running += 1;
		else if (item.status === "completed") done += 1;
		else if (item.status === "failed") failed += 1;
		else pending += 1;
	}
	return { running, done, failed, pending };
}

/** 完成计数文案：`已完成 X/Y`，X = completed，Y = 总数。 */
export function formatCompletion(items: readonly TodoItem[]): string {
	const done = items.filter((item) => item.status === "completed").length;
	return `${done}/${items.length}`;
}

/** 状态段中文文案：`进行中 1 · 已完成 2 · 失败 1 · 待办 3`（计数为 0 的段省略）。 */
export function formatTodoCounts(counts: TodoCounts): string {
	const parts: string[] = [];
	if (counts.running > 0) parts.push(`进行中 ${counts.running}`);
	if (counts.done > 0) parts.push(`已完成 ${counts.done}`);
	if (counts.failed > 0) parts.push(`失败 ${counts.failed}`);
	if (counts.pending > 0) parts.push(`待办 ${counts.pending}`);
	return parts.join(" · ");
}

/** 当前进行中的任务文本；无则 undefined（用于面板摘要"正在实现 X"）。 */
export function currentTaskText(items: readonly TodoItem[]): string | undefined {
	return items.find((item) => item.status === "in_progress")?.content;
}

/** 把一组子代理成员按状态计数（组头用）。 */
export function subagentGroupCounts(group: SubagentGroup): { running: number; done: number; failed: number } {
	let running = 0;
	let done = 0;
	let failed = 0;
	for (const member of group.members) {
		if (member.status === "running") running += 1;
		else if (member.status === "done") done += 1;
		else failed += 1;
	}
	return { running, done, failed };
}

/** 子代理计数段中文文案：`运行中 1 · 已完成 2 · 失败 1`。 */
export function formatSubagentCounts(counts: { running: number; done: number; failed: number }): string {
	const parts: string[] = [];
	if (counts.running > 0) parts.push(`运行中 ${counts.running}`);
	if (counts.done > 0) parts.push(`已完成 ${counts.done}`);
	if (counts.failed > 0) parts.push(`失败 ${counts.failed}`);
	return parts.join(" · ");
}

/**
 * 把连续的子代理成员聚合为分组（归组规则同终端：连续 task 合并成一组）。
 *
 * 输入是按对话顺序排列的成员序列，遇到 `breakGroup` 标记（非子代理调用）时切断当前组。
 * 这里用 `null` 作为分隔符，调用方在遍历 blocks 时把非子代理块映射为 null。
 */
export function buildSubagentGroups(sequence: readonly (SubagentMember | null)[]): SubagentGroup[] {
	const groups: SubagentGroup[] = [];
	let current: SubagentMember[] = [];
	const flush = (): void => {
		if (current.length === 0) return;
		const members = current;
		groups.push({
			members,
			...(members.every((member) => member.status !== "running")
				? {
						totalTokens: members.reduce((sum, member) => sum + (member.totalTokens ?? 0), 0),
					}
				: {}),
		});
		current = [];
	};
	for (const item of sequence) {
		if (item === null) flush();
		else current.push(item);
	}
	flush();
	return groups;
}
