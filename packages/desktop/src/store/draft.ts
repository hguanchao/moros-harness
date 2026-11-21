import type { ProjectRef, PreparedImage, SessionView } from "../shared/contract.ts";

/** 输入框附件上限；与新任务草稿共用，避免异步添加超过 UI 限制。 */
export const MAX_DRAFT_IMAGES = 8;

/**
 * 尚未发送的任务输入；项目关联仅在创建会话时生效，不迁移已有会话。
 * 模型与推理强度由 newTaskState 注入上一会话的选择；审批档位与计划模式不继承，
 * 未显式选择时沿用目标工作区配置，避免草稿隐式覆盖项目默认值。
 */
export interface TaskDraft {
	readonly text: string;
	readonly images: readonly PreparedImage[];
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
		project: null,
		branch: undefined,
		model: seed.model,
		effort: seed.effort,
		approval: undefined,
		plan: false,
	};
}
