import type { ProjectRef, PreparedImage, SessionView } from "../shared/contract.ts";

/** 输入框附件上限；与新任务草稿共用，避免异步添加超过 UI 限制。 */
export const MAX_DRAFT_IMAGES = 8;

/**
 * 尚未发送的任务输入；项目关联仅在创建会话时生效，不迁移已有会话。
 * 未选择的模型、推理强度与审批档位沿用目标工作区配置，避免草稿隐式覆盖项目默认值。
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
 * @returns 可由 reducer 不可变更新的草稿。
 * @example createTaskDraft()
 */
export function createTaskDraft(): TaskDraft {
	return {
		text: "",
		images: [],
		project: null,
		branch: undefined,
		model: undefined,
		effort: undefined,
		approval: undefined,
		plan: false,
	};
}
