/**
 * 工作步骤展示策略：把 UI 设置项翻译为对话流渲染所需的判定。
 *
 * 这里只放无副作用的纯函数，便于单测。默认值（standard / afterAnswer / all）
 * 必须与 `packages/core/src/config/schema.ts` 中 `ConfigSchema.ui` 的默认值保持一致，
 * 以保证设置项缺席时行为与新增前完全相同。
 */

/** 工具调用细节级别，对应设置项 `ui.workStepDetail`。 */
export type WorkStepDetail = "minimal" | "standard" | "detailed" | "full";

/** 工作步骤自动收起时机，对应设置项 `ui.collapseTiming`。 */
export type CollapseTiming = "never" | "immediately" | "afterToolCall" | "afterAnswer";

/** 收起后保留的助手回复，对应设置项 `ui.collapsedReplies`。 */
export type CollapsedReplies = "all" | "last" | "key" | "none";

/** 工具详情面板的渲染策略。 */
export interface ToolDetailPolicy {
	/** 是否在工具行主区域显示参数/结果摘要。 */
	readonly showSummary: boolean;
	/** 参数/结果详情面板是否默认展开。 */
	readonly defaultOpenDetail: boolean;
	/** 是否额外显示原始事件标识（诊断用）。 */
	readonly showRawEvent: boolean;
}

/**
 * 解析工具调用细节级别为渲染策略。
 *
 * - `minimal`：仅工具名与结果状态；
 * - `standard`：显示摘要，详情默认收起（与新增前行为一致）；
 * - `detailed`：详情默认展开；
 * - `full`：详情默认展开并显示原始事件标识。
 */
export function resolveToolDetail(level: WorkStepDetail): ToolDetailPolicy {
	switch (level) {
		case "minimal":
			return { showSummary: false, defaultOpenDetail: false, showRawEvent: false };
		case "standard":
			return { showSummary: true, defaultOpenDetail: false, showRawEvent: false };
		case "detailed":
			return { showSummary: true, defaultOpenDetail: true, showRawEvent: false };
		case "full":
			return { showSummary: true, defaultOpenDetail: true, showRawEvent: true };
	}
}

/**
 * 判断过程摘要（trail）是否应收起成「已工作 X」概览。
 *
 * - `never`：始终平铺，不收起；
 * - `afterAnswer`：回合完成且已离开活跃态才收起（与新增前行为一致）；
 * - `immediately` / `afterToolCall`：无在飞工具时立即收起；工具执行中保持平铺，不隐藏进行中的步骤。
 *
 * @param timing 自动收起时机设置。
 * @param ctx.isActive 是否为当前正在运行的最后一个回合。
 * @param ctx.hasRunningTool 回合内是否仍有执行中的工具调用。
 */
export function shouldCollapseTrail(
	timing: CollapseTiming,
	ctx: { readonly isActive: boolean; readonly hasRunningTool: boolean },
): boolean {
	switch (timing) {
		case "never":
			return false;
		case "afterAnswer":
			return !ctx.isActive;
		case "immediately":
		case "afterToolCall":
			// 工具执行中保持平铺，避免把正在进行的步骤藏进折叠摘要；无在飞工具时立即收起。
			return !ctx.hasRunningTool;
	}
}

/**
 * 判断一条「中间助手回复」（最终答案之前的正文）是否应保留在过程摘要中。
 *
 * - `all`：全部保留（与新增前行为一致）；
 * - `last`：仅保留最后一条中间回复；
 * - `key`：关键回复，当前等同 `last`，避免启发式误判；
 * - `none`：不保留任何中间回复。
 *
 * @param mode 收起后显示的回复设置。
 * @param ctx.isLast 该回复是否为最后一条中间回复。
 */
export function shouldKeepIntermediateReply(mode: CollapsedReplies, ctx: { readonly isLast: boolean }): boolean {
	switch (mode) {
		case "all":
			return true;
		case "last":
		case "key":
			return ctx.isLast;
		case "none":
			return false;
	}
}
