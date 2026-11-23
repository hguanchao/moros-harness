import type { ProjectRef, PreparedImage, SessionView } from "../shared/contract.ts";

/** 输入框附件上限；与新任务草稿共用，避免异步添加超过 UI 限制。 */
export const MAX_DRAFT_IMAGES = 8;

/** 引用 chip：选区原文快照（发送时才格式化为 `> ` 引用块）。 */
export interface DraftQuote {
	readonly id: string;
	readonly text: string;
}

/** @ 文件 / $ 技能引用 chip：发送时格式化为 `@path` / `$name` 并入正文。 */
export interface DraftMention {
	readonly id: string;
	readonly kind: "file" | "skill";
	/** 用于序列化的值（文件路径 / 技能名）。 */
	readonly value: string;
	/** chip 上显示的短标签。 */
	readonly label: string;
}

/**
 * 尚未发送的任务输入；项目关联仅在创建会话时生效，不迁移已有会话。
 * 模型与推理强度由 newTaskState 注入上一会话的选择；审批档位与计划模式不继承，
 * 未显式选择时沿用目标工作区配置，避免草稿隐式覆盖项目默认值。
 */
export interface TaskDraft {
	readonly text: string;
	readonly images: readonly PreparedImage[];
	/** 划词引用 chip；发送时格式化为 `> ` 块并入正文。 */
	readonly quotes: readonly DraftQuote[];
	/** @ 文件 / $ 技能引用 chip。 */
	readonly mentions: readonly DraftMention[];
	readonly project: ProjectRef | null;
	/** 首次发送前切换到的本地分支；仅在选择 Git 项目并选择分支后存在。 */
	readonly branch: string | undefined;
	readonly model: SessionView["model"];
	readonly effort: SessionView["effort"] | undefined;
	readonly approval: SessionView["approval"] | undefined;
	readonly plan: boolean;
}

/**
 * 创建未关联项目的空草稿，不创建任何文件或会话。
 * @param seed 新任务沿用上一会话的模型与推理强度；缺省时不带任何显式选择，全部沿用配置默认。
 * @returns 可由 reducer 不可变更新的草稿。
 * @example createTaskDraft({ model: previous.model, effort: previous.effort })
 */
export function createTaskDraft(
	seed: {
		readonly model?: SessionView["model"];
		readonly effort?: SessionView["effort"];
	} = {},
): TaskDraft {
	return {
		text: "",
		images: [],
		quotes: [],
		mentions: [],
		project: null,
		branch: undefined,
		model: seed.model,
		effort: seed.effort,
		approval: undefined,
		plan: false,
	};
}
