/**
 * 选择面板与菜单文案
 *
 * 界面文案按用途拆分，`copy.ts` 是唯一的对外入口；这里只放本段自己的词与句。
 */

// ── 面板 ──────────────────────────────────────────────────────────────────

/** 审批面板与各类菜单的固定文字。 */
export const PANEL = {
	/** 审批卡标题。 */
	permissionRequired: "Permission required",
	/** 展开详情的标题兜底。 */
	details: "Details",
	/** 参数为空。 */
	noArguments: "(no arguments)",
	/** 列表空态：空态是句子，句号收尾。 */
	noMatchingCommands: "No matching commands.",
	noOtherSessions: "No other sessions in this project.",
	noMatchingFiles: "No matching files.",
	noMatchingSkills: "No matching skills.",
	noSessions: "No sessions in this project yet.",
	/** 菜单里的当前项标记。 */
	current: "current",
	/** 顶部视图没有任何可显示的内容。 */
	noContent: "(no content)",
} as const;

/** 整屏查看器的标题：内容来源 + 全文/详情。 */
export const VIEWER_TITLE = {
	thinking: "Thinking",
	prompt: "Prompt",
} as const;

/** 工具输出的标题。 */
export function toolOutputTitle(name: string): string {
	return `${name} output`;
}

/** 工具详情的标题。 */
export function toolDetailsTitle(name: string): string {
	return `${name} details`;
}

/** 读图失败：前缀标明是图片，后面接单行原因。 */
export function imageError(reason: string): string {
	return `Image: ${reason}`;
}

/** 分叉会话在列表里的标题。 */
export function forkOf(source: string): string {
	return `↳ Fork of ${source}`;
}

/** 会话标题为空时的占位。 */
export const UNTITLED_SESSION = "Untitled session";

/** 思考等级说明：光看 low/high 判断不了该选哪档。 */
export const EFFORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
	off: "No reasoning; fastest responses",
	low: "Quick tasks where you review each result",
	medium: "Everyday work with a clear scope",
	high: "Work where correctness and edge cases matter",
	minimal: "Minimal reasoning; fastest responses that still think",
	max: "Hard problems that need sustained reasoning",
};

/** 审批动作：三档写法对称，都写清按下之后会发生什么。 */
export const APPROVAL = {
	proceed: "Yes, proceed",
	deny: "No, deny",
	/** 窄屏退路：只留判定词。 */
	proceedShort: "Yes",
	alwaysShort: "Always",
	denyShort: "No",
} as const;

/** 记住档：作用域与 Core 的 allow-session 一致（shell 是命令前缀，其余是工具名），并写清有效期。 */
export function alwaysAllowScope(scope: string): string {
	return `Yes, always allow "${scope}" for this session`;
}

/**
 * 审批卡的风险徽标。
 *
 * low 不出徽标：真正需要看风险的是「打断你」和「自动放行」的那两档，每张卡都挂一个
 * LOW 只会训练使用者忽略徽标。
 */
export const RISK_LABELS: Readonly<Record<string, string>> = {
	medium: "MEDIUM RISK",
	high: "HIGH RISK",
};
