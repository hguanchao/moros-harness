/** 审批面板展示所需的请求；由 Core 的审批请求经适配器转换而来。 */
export interface ApprovalRequest {
	readonly tool: string;
	readonly risk: string;
	readonly detail: string;
	readonly summary?: string;
	readonly preview?: string;
	readonly previewLabel?: string;
	/**
	 * 「本会话记住」的作用范围短词；缺省时不提供记住档。
	 * 取值由 Core 的 `approvalScope` 计算：shell 是命令前缀，其余是工具名。
	 */
	readonly saveShort?: string;
}

/** 审批卡给出的三种决定；always 映射为 Core 的 allow-session。 */
export type ApprovalAnswer = "once" | "always" | "deny";

/** tui 内部使用的审批请求别名。 */
export type ApprovalPrompt = ApprovalRequest;

/** 宿主注入的审批队列句柄；TUI 只消费方法，不关心其背后的排队实现。 */
export interface ApprovalBroker {
	request(request: ApprovalRequest): Promise<ApprovalAnswer>;
	pending(): ApprovalPrompt | undefined;
	pendingId(): number | undefined;
	resolve(answer: ApprovalAnswer, id?: number): void;
	denyAll(): void;
}
